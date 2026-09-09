import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

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
import { CsvParseError, parseCsv } from "~/lib/pricing/csv/parse";
import { planImport, skusIn, type ImportPlan } from "~/lib/pricing/csv/plan";
import { resolveSkus } from "~/lib/pricing/csv/skus.server";
import { exportFor, templateCsv } from "~/lib/pricing/csv/export.server";
import { detectTemplate, isTemplateKey, TEMPLATES } from "~/lib/pricing/csv/templates";
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

        const { plan } = await buildPlan(draft.content, admin);

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
      return json({ view: fileErrorView(error) }, { status: 422 });
    }

    // Held server-side: a browser will not resubmit a file input, so the
    // confirm step has to import exactly the bytes that were checked rather
    // than ask for the file again.
    const draft = await db.ruleImportDraft.create({
      data: { ...tenant(), fileName: file.name, content },
    });

    const { rules: existing } = await activeEngineRules();
    const size = estimatePublishedSize(
      existing,
      plan.planned.map((item) => item.rule),
    );

    const review: NonNullable<CsvView["review"]> = {
      draftId: draft.id,
      fileName: file.name,
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
    };

    return json({ view: { ...EMPTY_VIEW, step: "review" as const, review } });
  });

async function buildPlan(content: string, admin: Parameters<typeof resolveSkus>[0]) {
  const doc = parseCsv(content);
  if (doc.rows.length > MAX_ROWS) throw new TooManyRowsError(doc.rows.length);

  const template = detectTemplate(doc.headers);
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
  const { view } = useLoaderData<typeof loader>();
  return <CsvPage view={view as CsvView} />;
}
