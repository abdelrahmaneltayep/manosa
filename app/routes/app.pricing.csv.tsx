import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useActionData, useLoaderData } from "@remix-run/react";

import { CsvPage, type CsvView } from "~/components/pricing/CsvPage";
import { db } from "~/db.server";
import { detectLocale, getFixedT } from "~/i18n.server";
import { isPlanGateError } from "~/lib/billing/gate.server";
import {
  errorCsv,
  estimatePublishedSize,
  FileTooLargeError,
  MAX_FILE_BYTES,
  MAX_ROWS,
  runImport,
  TooManyRowsError,
  undoImport,
  UndoExpiredError,
} from "~/lib/pricing/csv/import.server";
import { isAiAvailable } from "~/lib/ai/client.server";
import {
  mapColumns,
  toColumnMapping,
  type ColumnGuess,
} from "~/lib/ai/prompts/csv-mapping.server";
import {
  applyMapping,
  CsvParseError,
  parseCsv,
  type ColumnMapping,
} from "~/lib/pricing/csv/parse";
import { planImport, skusIn, type ImportPlan } from "~/lib/pricing/csv/plan";
import { resolveSkus } from "~/lib/pricing/csv/skus.server";
import { exportFor, templateCsv } from "~/lib/pricing/csv/export.server";
import {
  detectTemplate,
  isTemplateKey,
  TEMPLATES,
  type TemplateKey,
} from "~/lib/pricing/csv/templates";
import { activeEngineRules, listRules } from "~/lib/pricing/rules.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { withAdmin } from "~/shopify.server";

/**
 * The review step is held in the session cookie rather than the database: it is
 * a draft the merchant has not agreed to, and an abandoned upload should leave
 * nothing behind. Files are re-parsed on confirm from the same upload.
 */
const EMPTY_VIEW: CsvView = {
  step: "choose",
  mapping: null,
  fileError: null,
  review: null,
  imported: null,
  undone: null,
  undoExpired: false,
};

function csvResponse(body: string, fileName: string) {
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
    },
  });
}

export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async () => {
    const url = new URL(request.url);
    const download = url.searchParams.get("download");
    const templateParam = url.searchParams.get("template");
    const template = isTemplateKey(templateParam) ? templateParam : "rules";

    if (download === "template") {
      return csvResponse(templateCsv(template), `mannon-${template}-template.csv`);
    }

    if (download === "export") {
      const page = await listRules({ pageSize: 5000 });
      return csvResponse(exportFor(template, page.rows), `mannon-${template}.csv`);
    }

    return json({ view: EMPTY_VIEW });
  });

export const action = ({ request }: ActionFunctionArgs) =>
  withAdmin(request, async ({ admin, session }) => {
    const contentType = request.headers.get("content-type") ?? "";
    const t = await getFixedT(detectLocale(request));
    const actor = { type: "STAFF" as const, id: session.id };

    // Multipart is the upload; everything else is a button on the review or
    // result step.
    if (!contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const intent = (form.get("intent") ?? "").toString();

      if (intent === "confirm" || intent === "errors") {
        const draftId = (form.get("draftId") ?? "").toString();
        const draft = await db.ruleImportDraft.findUnique({ where: { id: draftId } });
        if (!draft) return redirect("/app/pricing/csv");

        const { plan } = await buildPlan(draft.content, admin, mappedDraft(draft));

        if (intent === "errors") {
          return csvResponse(
            errorCsv(plan, (code, params) => t(code, params ?? {}) as string),
            "mannon-import-problems.csv",
          );
        }

        const { rules: existing } = await activeEngineRules();
        const size = estimatePublishedSize(
          existing,
          plan.planned.map((item) => item.rule),
        );
        if (size.exceeds || plan.planned.length === 0) {
          return redirect("/app/pricing/csv");
        }

        try {
          const result = await runImport(plan, {
            fileName: draft.fileName,
            admin,
            actor,
          });
          await db.ruleImportDraft.delete({ where: { id: draftId } });
          return json({
            view: {
              ...EMPTY_VIEW,
              step: "imported" as const,
              imported: { count: result.created, importId: result.importId },
            },
          });
        } catch (error) {
          if (isPlanGateError(error)) return redirect("/app/plans?from=import");
          throw error;
        }
      }

      if (intent === "map") {
        const draftId = (form.get("draftId") ?? "").toString();
        const draft = await db.ruleImportDraft.findUnique({ where: { id: draftId } });
        if (!draft) return redirect("/app/pricing/csv");

        const templateParam = (form.get("template") ?? "").toString();
        const template: TemplateKey = isTemplateKey(templateParam)
          ? templateParam
          : "rules";

        // The merchant's mapping, not the model's: whatever the selects say is
        // what gets applied, whether Claude proposed it or they changed it.
        const mapping: ColumnMapping = {};
        for (const [key, value] of form.entries()) {
          if (!key.startsWith("column:")) continue;
          const column = value.toString();
          mapping[key.slice("column:".length)] = column === "" ? null : column;
        }

        await db.ruleImportDraft.update({
          where: { id: draftId },
          data: { mapping, template },
        });

        try {
          const { plan, headers } = await buildPlan(draft.content, admin, {
            mapping,
            template,
          });
          return json({
            view: await reviewView(plan, headers, draft.id, draft.fileName),
          });
        } catch (error) {
          return json({ view: fileErrorView(error) }, { status: 422 });
        }
      }

      if (intent === "undo") {
        try {
          const result = await undoImport((form.get("importId") ?? "").toString(), {
            admin,
            actor,
          });
          return json({
            view: {
              ...EMPTY_VIEW,
              step: "undone" as const,
              undone: { count: result.deleted },
            },
          });
        } catch (error) {
          if (error instanceof UndoExpiredError) {
            return json({ view: { ...EMPTY_VIEW, undoExpired: true } });
          }
          throw error;
        }
      }

      return redirect("/app/pricing/csv");
    }

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return json({ view: EMPTY_VIEW }, { status: 400 });
    }

    if (file.size > MAX_FILE_BYTES) {
      return json(
        { view: fileErrorView(new FileTooLargeError(file.size)) },
        { status: 422 },
      );
    }

    const content = await file.text();
    let plan: ImportPlan;
    let headers: string[];

    try {
      const built = await buildPlan(content, admin);
      plan = built.plan;
      headers = built.headers;
    } catch (error) {
      // ✦ Headers that match no template used to end here. Now they go to the
      // mapping screen, where Claude proposes what each column is and the
      // merchant fixes it — spec §2, "no rigid template required".
      if (error instanceof UnknownTemplateError) {
        return json({ view: await mappingView(content, file.name, session.id) });
      }
      return json({ view: fileErrorView(error) }, { status: 422 });
    }

    // Held server-side: a browser will not resubmit a file input, so the
    // confirm step has to import exactly the bytes that were checked rather
    // than ask for the file again.
    const draft = await db.ruleImportDraft.create({
      data: { ...tenant(), fileName: file.name, content },
    });

    return json({ view: await reviewView(plan, headers, draft.id, file.name) });
  });

/** The dry-run report. Shared by a file that matched and one that was mapped. */
async function reviewView(
  plan: ImportPlan,
  headers: string[],
  draftId: string,
  fileName: string,
): Promise<CsvView> {
  const { rules: existing } = await activeEngineRules();
  const size = estimatePublishedSize(
    existing,
    plan.planned.map((item) => item.rule),
  );

  return {
    ...EMPTY_VIEW,
    step: "review",
    review: {
      draftId,
      fileName,
      template: plan.template,
      columns: headers.map((header) => ({
        header,
        matched: TEMPLATES[plan.template].columns.some((column) => column.key === header),
      })),
      totalRows: plan.totalRows,
      willCreate: plan.planned.length,
      errors: plan.errors,
      warnings: plan.warnings,
      tooLarge: size.exceeds ? { bytes: size.bytes, limit: size.limit } : null,
    },
  };
}

/** A stored mapping, read back defensively — it is JSON on a row. */
function mappedDraft(draft: {
  mapping: unknown;
  template: string | null;
}): { mapping: ColumnMapping; template: TemplateKey } | null {
  if (!draft.mapping || typeof draft.mapping !== "object") return null;
  if (!isTemplateKey(draft.template)) return null;

  const mapping: ColumnMapping = {};
  for (const [header, column] of Object.entries(
    draft.mapping as Record<string, unknown>,
  )) {
    mapping[header] = typeof column === "string" && column !== "" ? column : null;
  }
  return { mapping, template: draft.template };
}

/**
 * ✦ Propose a mapping for a file whose headers matched nothing.
 *
 * The file is held first: the merchant is going to spend a minute on this
 * screen, and losing their upload to a model timeout would be the worst
 * possible moment for it. With no key — or a failed call — every column starts
 * as "ignore" and the merchant maps it themselves, which is exactly what they
 * would have had to do without this feature.
 */
async function mappingView(
  content: string,
  fileName: string,
  actorId: string,
): Promise<CsvView> {
  const doc = parseCsv(content);
  const template: TemplateKey = "rules";

  const draft = await db.ruleImportDraft.create({
    data: { ...tenant(), fileName, content, template },
  });

  const proposed = isAiAvailable() ? await mapColumns(doc, template, { actorId }) : null;

  const guesses: ColumnGuess[] = proposed?.ok
    ? proposed.value.mappings
    : doc.headers.map((header) => ({
        header,
        // A header that happens to be a column key already is not a guess.
        column: TEMPLATES[template].columns.some((column) => column.key === header)
          ? header
          : null,
        confidence: "low" as const,
      }));

  // Stored as proposed, so the held draft matches what the merchant is looking
  // at. Confirming re-reads the mapping from the form either way; this is what
  // a reload or a second tab would otherwise lose.
  await db.ruleImportDraft.update({
    where: { id: draft.id },
    data: { mapping: toColumnMapping(guesses) },
  });

  const byHeader = new Map(guesses.map((guess) => [guess.header, guess]));
  const mapped = new Set(
    guesses.map((guess) => guess.column).filter((key): key is string => key !== null),
  );

  return {
    ...EMPTY_VIEW,
    step: "map",
    mapping: {
      draftId: draft.id,
      fileName,
      template,
      rows: doc.headers.map((header) => {
        const guess = byHeader.get(header);
        return {
          header,
          column: guess?.column ?? "",
          confidence: guess?.confidence ?? "low",
          samples: doc.rows
            .slice(0, 3)
            .map((row) => row.cells[header] ?? "")
            .filter((value) => value !== ""),
        };
      }),
      targets: TEMPLATES[template].columns.map((column) => ({
        key: column.key,
        required: column.required,
      })),
      notes: proposed?.ok ? proposed.value.notes : null,
      aiFailure: proposed && !proposed.ok ? proposed.reason : null,
      missingRequired: TEMPLATES[template].columns
        .filter((column) => column.required && !mapped.has(column.key))
        .map((column) => column.key),
    },
  };
}

async function buildPlan(
  content: string,
  admin: Parameters<typeof resolveSkus>[0],
  mapped?: { mapping: ColumnMapping; template: TemplateKey } | null,
) {
  const parsed = parseCsv(content);
  if (parsed.rows.length > MAX_ROWS) throw new TooManyRowsError(parsed.rows.length);

  // ✦ A confirmed mapping is applied before anything else looks at the file, so
  // the planner, the row numbers and the error report all work on the merchant's
  // own file and know nothing about the mapping.
  const doc = mapped ? applyMapping(parsed, mapped.mapping) : parsed;
  const template = mapped?.template ?? detectTemplate(doc.headers);
  if (!template) throw new UnknownTemplateError();

  // Resolved before planning, so an unknown SKU is a listed error rather than
  // a rule that quietly targets nothing.
  const skuToVariantId = await resolveSkus(admin, skusIn(doc));

  const shop = await db.shop.findUnique({ where: { shop: shopScope.require("csv") } });
  const existing = await listRules({ pageSize: 5000 });

  const plan = planImport(doc, template, {
    currencyCode: shop?.currencyCode ?? "USD",
    skuToVariantId,
    existingNames: new Set(existing.rows.map((row) => row.name.trim().toLowerCase())),
    now: new Date(),
  });

  return { plan, headers: doc.headers };
}

class UnknownTemplateError extends Error {
  constructor() {
    super("Unrecognised columns");
    this.name = "UnknownTemplateError";
  }
}

function fileErrorView(error: unknown): CsvView {
  if (error instanceof FileTooLargeError) {
    return {
      ...EMPTY_VIEW,
      fileError: { code: "too_large", sizeMb: Math.round(error.bytes / 1024 / 1024) },
    };
  }
  if (error instanceof TooManyRowsError) {
    return {
      ...EMPTY_VIEW,
      fileError: { code: "too_many_rows", rows: error.rows, limit: MAX_ROWS },
    };
  }
  if (error instanceof UnknownTemplateError) {
    return { ...EMPTY_VIEW, fileError: { code: "unknown_template" } };
  }
  if (error instanceof CsvParseError) {
    return { ...EMPTY_VIEW, fileError: { code: "unreadable", detail: error.message } };
  }
  throw error;
}

export default function PricingCsv() {
  // The action's view wins. A non-redirect action response re-runs the loader,
  // so reading only the loader's copy throws away everything the action just
  // computed — the validation errors, the report, the draft.
  const actionData = useActionData<typeof action>();
  const loaderData = useLoaderData<typeof loader>();
  const { view } = actionData ?? loaderData;
  return <CsvPage view={view as CsvView} />;
}
