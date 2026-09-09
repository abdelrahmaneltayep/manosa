import { useTranslation } from "react-i18next";

import { whenChecked, whenDisabled } from "~/components/boolean-attribute";
import type { BuilderTab, FieldRowView, FormBuilderView } from "~/components/forms/types";
import { FIELD_KINDS, MAX_UPLOAD_BYTES } from "~/lib/forms/schema";
import { MAX_WIDTH, MIN_WIDTH } from "~/lib/forms/appearance";
import { EMAIL_KEYS, MERGE_TAGS } from "~/lib/forms/merge-tags";

const TABS: BuilderTab[] = ["configuration", "appearance", "emails", "publish"];

/**
 * The form builder.
 *
 * Four tabs, because that is the IA a merchant already knows from the tools
 * they are switching from. The thing this screen owes them is that nothing
 * here can publish a form that quietly rejects applications: going live is
 * refused while any issue stands, and the issues say what to do.
 */
export function FormBuilderPage({ view }: { view: FormBuilderView }) {
  const { t } = useTranslation();
  const blocked = view.definitionIssues.length + view.emailIssues.length;

  return (
    <s-page heading={view.name}>
      <ui-save-bar id="form-save-bar">
        <button variant="primary" id="form-save" />
        <button id="form-discard" />
      </ui-save-bar>

      <s-section>
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-link href="/app/forms">{t("forms.builder.backToForms")}</s-link>
          <s-badge tone={view.status === "LIVE" ? "success" : "neutral"}>
            {t(`forms.status.${view.status}`)}
          </s-badge>
        </s-stack>
      </s-section>

      {blocked > 0 ? <Issues view={view} /> : null}

      <s-section>
        <s-stack direction="inline" gap="small" alignItems="center">
          {TABS.map((tab) => (
            <s-link
              key={tab}
              href={`/app/forms/${view.id}?tab=${tab}`}
              {...(view.tab === tab ? { "aria-current": "page" } : {})}
            >
              {t(`forms.builder.tab.${tab}`)}
            </s-link>
          ))}
        </s-stack>
      </s-section>

      {view.tab === "configuration" ? <Configuration view={view} /> : null}
      {view.tab === "appearance" ? <AppearanceTab view={view} /> : null}
      {view.tab === "emails" ? <Emails view={view} /> : null}
      {view.tab === "publish" ? <Publish view={view} /> : null}
    </s-page>
  );
}

function Issues({ view }: { view: FormBuilderView }) {
  const { t } = useTranslation();

  return (
    <s-section>
      <s-banner tone="warning">
        <s-heading>{t("forms.builder.issuesHeading")}</s-heading>
        {/* Not an error banner: a draft is allowed to be unfinished. It says
            what stands between this form and going live. */}
        <s-paragraph>{t("forms.builder.issuesBody")}</s-paragraph>
        <s-unordered-list>
          {view.definitionIssues.map((issue) => (
            <s-list-item key={`${issue.code}-${issue.key ?? ""}`}>
              {t(`forms.issue.${issue.code}`, {
                field: issue.key ?? "",
                detail: issue.detail ?? "",
              })}
            </s-list-item>
          ))}
          {view.emailIssues.map((issue) => (
            <s-list-item key={`${issue.email}-${issue.code}-${issue.detail ?? ""}`}>
              {t(`forms.emailIssue.${issue.code}`, {
                email: t(`forms.emails.${issue.email}`),
                detail: issue.detail ?? "",
              })}
            </s-list-item>
          ))}
        </s-unordered-list>
      </s-banner>
    </s-section>
  );
}

/* -------------------------------------------------------------------------- */

function Configuration({ view }: { view: FormBuilderView }) {
  const { t } = useTranslation();

  return (
    <>
      <s-section heading={t("forms.builder.tab.configuration")}>
        <form method="post">
          <input type="hidden" name="intent" value="details" />
          <s-stack direction="block" gap="small">
            <s-text-field
              name="name"
              label={t("forms.builder.nameLabel")}
              value={view.name}
            />
            <s-text-field
              name="slug"
              label={t("forms.builder.slugLabel")}
              details={t("forms.builder.slugHelp")}
              value={view.slug}
            />
            <s-button type="submit" variant="primary">
              {t("forms.builder.save")}
            </s-button>
          </s-stack>
        </form>
      </s-section>

      <s-section heading={t("forms.builder.fieldsHeading")}>
        {view.fields.length === 0 ? (
          <s-paragraph color="subdued">{t("forms.builder.noFields")}</s-paragraph>
        ) : (
          <s-stack direction="block" gap="small">
            {view.fields.map((field) => (
              <FieldRow key={field.key} field={field} view={view} />
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section heading={t("forms.builder.addFieldHeading")}>
        <form method="post">
          <input type="hidden" name="intent" value="addField" />
          <s-stack direction="block" gap="small">
            <s-text-field name="label" label={t("forms.builder.fieldLabel")} />
            <s-select name="kind" label={t("forms.builder.fieldKind")} value="text">
              {FIELD_KINDS.map((kind) => (
                <s-option key={kind} value={kind}>
                  {t(`forms.fieldKind.${kind}`)}
                </s-option>
              ))}
            </s-select>
            <s-text-field
              name="options"
              label={t("forms.builder.fieldOptions")}
              details={t("forms.builder.fieldOptionsHelp")}
            />
            <s-checkbox name="required" value="yes" label={t("forms.builder.required")} />
            <s-button type="submit">{t("forms.builder.addField")}</s-button>
          </s-stack>
        </form>
      </s-section>
    </>
  );
}

function FieldRow({ field, view }: { field: FieldRowView; view: FormBuilderView }) {
  const { t } = useTranslation();
  const others = view.fields.filter((other) => other.key !== field.key);

  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack direction="block" gap="small">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-text type="strong">{field.label}</s-text>
          <s-badge tone="neutral">{t(`forms.fieldKind.${field.kind}`)}</s-badge>
          {field.required ? (
            <s-badge tone="info">{t("forms.builder.required")}</s-badge>
          ) : null}
          {field.kind === "vat" && view.vatExample ? (
            <s-text color="subdued">
              {t("forms.builder.vatExample", { example: view.vatExample })}
            </s-text>
          ) : null}
        </s-stack>

        {field.showWhen ? (
          <s-text color="subdued">
            {t("forms.builder.showsWhen", {
              field: field.showWhen.field,
              value: field.showWhen.equals,
            })}
          </s-text>
        ) : null}

        <s-stack direction="inline" gap="small-500" alignItems="center">
          {/* Reorder as buttons rather than only drag: the checklist asks for
              keyboard support, and a button is the keyboard support. */}
          <form method="post">
            <input type="hidden" name="intent" value="moveField" />
            <input type="hidden" name="key" value={field.key} />
            <input type="hidden" name="direction" value="up" />
            <s-button
              type="submit"
              variant="tertiary"
              accessibilityLabel={t("forms.builder.moveUpFor", { label: field.label })}
              {...whenDisabled(field.index === 0)}
            >
              {t("forms.builder.moveUp")}
            </s-button>
          </form>
          <form method="post">
            <input type="hidden" name="intent" value="moveField" />
            <input type="hidden" name="key" value={field.key} />
            <input type="hidden" name="direction" value="down" />
            <s-button
              type="submit"
              variant="tertiary"
              accessibilityLabel={t("forms.builder.moveDownFor", { label: field.label })}
              {...whenDisabled(field.index === view.fields.length - 1)}
            >
              {t("forms.builder.moveDown")}
            </s-button>
          </form>
          <form method="post">
            <input type="hidden" name="intent" value="toggleRequired" />
            <input type="hidden" name="key" value={field.key} />
            <s-button type="submit" variant="tertiary">
              {field.required
                ? t("forms.builder.makeOptional")
                : t("forms.builder.makeRequired")}
            </s-button>
          </form>
          <form method="post">
            <input type="hidden" name="intent" value="removeField" />
            <input type="hidden" name="key" value={field.key} />
            <s-button type="submit" variant="tertiary" tone="critical">
              {t("forms.builder.removeField")}
            </s-button>
          </form>
        </s-stack>

        <form method="post">
          <input type="hidden" name="intent" value="setCondition" />
          <input type="hidden" name="key" value={field.key} />
          <s-stack direction="inline" gap="small" alignItems="end">
            <s-select
              name="conditionField"
              label={t("forms.builder.conditionField")}
              value={field.showWhen?.field ?? ""}
            >
              <s-option value="">{t("forms.builder.alwaysShown")}</s-option>
              {others.map((other) => (
                <s-option key={other.key} value={other.key}>
                  {other.label}
                </s-option>
              ))}
            </s-select>
            <s-text-field
              name="conditionValue"
              label={t("forms.builder.conditionValue")}
              value={field.showWhen?.equals ?? ""}
            />
            <s-button type="submit" variant="tertiary">
              {t("forms.builder.applyCondition")}
            </s-button>
          </s-stack>
        </form>
      </s-stack>
    </s-box>
  );
}

/* -------------------------------------------------------------------------- */

function AppearanceTab({ view }: { view: FormBuilderView }) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("forms.builder.tab.appearance")}>
      <form method="post">
        <input type="hidden" name="intent" value="appearance" />
        <s-stack direction="block" gap="small">
          <s-select
            name="layout"
            label={t("forms.appearance.layout")}
            value={view.appearance.layout}
          >
            <s-option value="default">{t("forms.appearance.layoutDefault")}</s-option>
            <s-option value="boxed">{t("forms.appearance.layoutBoxed")}</s-option>
          </s-select>
          <s-number-field
            name="width"
            label={t("forms.appearance.width")}
            details={t("forms.appearance.widthHelp", { min: MIN_WIDTH, max: MAX_WIDTH })}
            value={String(view.appearance.width)}
            min={MIN_WIDTH}
            max={MAX_WIDTH}
          />
          <s-select
            name="font"
            label={t("forms.appearance.font")}
            value={view.appearance.font}
          >
            <s-option value="system">{t("forms.appearance.fontSystem")}</s-option>
            <s-option value="serif">{t("forms.appearance.fontSerif")}</s-option>
            <s-option value="mono">{t("forms.appearance.fontMono")}</s-option>
          </s-select>
          <s-text-field
            name="background"
            label={t("forms.appearance.background")}
            value={view.appearance.background}
          />
          <s-text-field
            name="text"
            label={t("forms.appearance.text")}
            value={view.appearance.text}
          />
          <s-text-field
            name="accent"
            label={t("forms.appearance.accent")}
            value={view.appearance.accent}
          />
          <s-text-field
            name="accentText"
            label={t("forms.appearance.accentText")}
            value={view.appearance.accentText}
          />
          <s-button type="submit" variant="primary">
            {t("forms.builder.save")}
          </s-button>
        </s-stack>
      </form>

      <Contrast view={view} />
    </s-section>
  );
}

function Contrast({ view }: { view: FormBuilderView }) {
  const { t } = useTranslation();

  const line = (key: "text" | "accent") => {
    const verdict = view.contrast[key];
    if (verdict.unreadable) {
      return (
        <s-banner key={key} tone="critical">
          <s-paragraph>{t("forms.contrast.unreadable")}</s-paragraph>
        </s-banner>
      );
    }
    return (
      <s-banner key={key} tone={verdict.passesAA ? "success" : "critical"}>
        <s-paragraph>
          {/* Named, with the number, and what to do — "fails" alone leaves the
              merchant guessing which of four colours to change. */}
          {verdict.passesAA
            ? t(`forms.contrast.pass.${key}`, { ratio: verdict.ratio })
            : t(`forms.contrast.fail.${key}`, { ratio: verdict.ratio })}
        </s-paragraph>
      </s-banner>
    );
  };

  return (
    <s-stack direction="block" gap="small">
      <s-heading>{t("forms.contrast.heading")}</s-heading>
      {line("text")}
      {line("accent")}
    </s-stack>
  );
}

/* -------------------------------------------------------------------------- */

function Emails({ view }: { view: FormBuilderView }) {
  const { t } = useTranslation();

  return (
    <>
      <s-section heading={t("forms.builder.tab.emails")}>
        <s-paragraph color="subdued">
          {t("forms.emails.tagsHelp", {
            tags: MERGE_TAGS.map((tag) => `{{${tag}}}`).join(" · "),
          })}
        </s-paragraph>
        {view.testSend === "no_sender" ? (
          <s-banner tone="warning">
            <s-heading>{t("forms.emails.noSenderHeading")}</s-heading>
            {/* Saying so beats a button that reports success and sends
                nothing — the merchant would find out from an applicant. */}
            <s-paragraph>{t("forms.emails.noSenderBody")}</s-paragraph>
          </s-banner>
        ) : null}
        {view.testSend === "sent" ? (
          <s-banner tone="success">
            <s-paragraph>{t("forms.emails.testSent")}</s-paragraph>
          </s-banner>
        ) : null}
      </s-section>

      {EMAIL_KEYS.map((key) => (
        <s-section key={key} heading={t(`forms.emails.${key}`)}>
          <form method="post">
            <input type="hidden" name="intent" value="emails" />
            <input type="hidden" name="email" value={key} />
            <s-stack direction="block" gap="small">
              <s-text-field
                name="subject"
                label={t("forms.emails.subject")}
                value={view.emails[key].subject}
              />
              <s-text-area
                name="body"
                label={t("forms.emails.body")}
                value={view.emails[key].body}
              />
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-button type="submit" variant="primary">
                  {t("forms.builder.save")}
                </s-button>
              </s-stack>
            </s-stack>
          </form>
          <form method="post">
            <input type="hidden" name="intent" value="testSend" />
            <input type="hidden" name="email" value={key} />
            <s-button type="submit" variant="tertiary">
              {t("forms.emails.testSend")}
            </s-button>
          </form>
        </s-section>
      ))}
    </>
  );
}

/* -------------------------------------------------------------------------- */

function Publish({ view }: { view: FormBuilderView }) {
  const { t } = useTranslation();
  const blocked = view.definitionIssues.length + view.emailIssues.length > 0;

  return (
    <>
      <s-section heading={t("forms.builder.tab.publish")}>
        <s-stack direction="block" gap="small">
          <s-text-field
            label={t("forms.publish.linkLabel")}
            details={t("forms.publish.linkHelp")}
            value={view.publicUrl}
            readOnly
          />
          <s-paragraph color="subdued">{t("forms.publish.blockHelp")}</s-paragraph>

          <form method="post">
            <input type="hidden" name="intent" value="status" />
            <input
              type="hidden"
              name="status"
              value={view.status === "LIVE" ? "DRAFT" : "LIVE"}
            />
            <s-button
              type="submit"
              variant="primary"
              {...whenDisabled(view.status !== "LIVE" && blocked)}
            >
              {view.status === "LIVE"
                ? t("forms.publish.unpublish")
                : t("forms.publish.publish")}
            </s-button>
          </form>
          {view.status !== "LIVE" && blocked ? (
            <s-text color="subdued">{t("forms.publish.blockedByIssues")}</s-text>
          ) : null}
        </s-stack>
      </s-section>

      <s-section heading={t("forms.publish.settingsHeading")}>
        <form method="post">
          <input type="hidden" name="intent" value="publishSettings" />
          <s-stack direction="block" gap="small">
            <s-text-field
              name="redirectUrl"
              label={t("forms.publish.redirectLabel")}
              details={t("forms.publish.redirectHelp")}
              value={view.publish.redirectUrl}
            />
            <s-text-field
              name="autoTags"
              label={t("forms.publish.autoTagsLabel")}
              details={t("forms.publish.autoTagsHelp")}
              value={view.publish.autoTags.join(", ")}
            />
            <s-select
              name="autoGroupId"
              label={t("forms.publish.autoGroupLabel")}
              value={view.publish.autoGroupId ?? ""}
            >
              <s-option value="">{t("forms.publish.autoGroupNone")}</s-option>
              {view.groups.map((group) => (
                <s-option key={group.id} value={group.id}>
                  {group.name}
                </s-option>
              ))}
            </s-select>
            <s-checkbox
              name="spamProtection"
              value="yes"
              label={t("forms.publish.spamLabel")}
              details={t("forms.publish.spamHelp", {
                megabytes: Math.round(MAX_UPLOAD_BYTES / (1024 * 1024)),
              })}
              {...whenChecked(view.publish.spamProtection)}
            />
            <s-button type="submit" variant="primary">
              {t("forms.builder.save")}
            </s-button>
          </s-stack>
        </form>
      </s-section>

      <s-section heading={t("forms.publish.recentHeading", { count: view.recentTotal })}>
        {view.recent.length === 0 ? (
          <s-paragraph color="subdued">{t("forms.publish.noApplications")}</s-paragraph>
        ) : (
          <s-stack direction="block" gap="small">
            <s-table>
              <s-table-header-row>
                <s-table-header>{t("forms.publish.colWho")}</s-table-header>
                <s-table-header>{t("forms.publish.colWhen")}</s-table-header>
                <s-table-header>{t("forms.publish.colVat")}</s-table-header>
                <s-table-header>{t("forms.publish.colFiles")}</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {view.recent.map((row) => (
                  <s-table-row key={row.id}>
                    <s-table-cell>{row.who}</s-table-cell>
                    <s-table-cell>{row.at}</s-table-cell>
                    <s-table-cell>
                      <s-badge
                        tone={
                          row.vatStatus === "VALID"
                            ? "success"
                            : row.vatStatus === "INVALID"
                              ? "critical"
                              : "neutral"
                        }
                      >
                        {t(`forms.vat.${row.vatStatus}`)}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      {row.uploads.length === 0 ? (
                        <s-text color="subdued">{t("forms.publish.noFiles")}</s-text>
                      ) : (
                        <s-stack direction="block" gap="small-500">
                          {row.uploads.map((upload) => (
                            <s-stack
                              key={upload.id}
                              direction="inline"
                              gap="small-500"
                              alignItems="center"
                            >
                              <s-link href={`/app/forms/upload/${upload.id}`}>
                                {upload.fileName}
                              </s-link>
                              {/* Nothing has scanned this. Saying so beats
                                  implying it is clean. */}
                              {upload.scanned ? null : (
                                <s-badge tone="caution">
                                  {t("forms.publish.notScanned")}
                                </s-badge>
                              )}
                            </s-stack>
                          ))}
                        </s-stack>
                      )}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
            <s-text color="subdued">{t("forms.publish.queueComing")}</s-text>
          </s-stack>
        )}
      </s-section>
    </>
  );
}
