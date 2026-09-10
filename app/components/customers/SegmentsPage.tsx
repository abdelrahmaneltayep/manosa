import { useTranslation } from "react-i18next";

import { whenDisabled } from "~/components/boolean-attribute";
import type {
  SegmentChipView,
  SegmentDraftView,
  SegmentsView,
} from "~/components/customers/types";

/**
 * ✦ Segment builder — checklist §3.
 *
 * "Query streamed to visible filter chips — chips editable after generation (AI
 * output is inspectable, not a black box)." The chips are the whole point: what
 * Claude read out of the sentence is on screen as a short list a merchant can
 * remove from and re-run, not a query hidden behind a number.
 */
export function SegmentsPage({ view }: { view: SegmentsView }) {
  const { t } = useTranslation();

  return (
    <s-page heading={t("segments.heading")}>
      <Composer view={view} />
      {view.draft ? <Draft view={view} draft={view.draft} /> : null}
      <Saved view={view} />
    </s-page>
  );
}

function Composer({ view }: { view: SegmentsView }) {
  const { t } = useTranslation();

  return (
    <s-section heading={t("segments.composerHeading")}>
      <s-stack direction="block" gap="base">
        {view.aiAvailable ? null : (
          <s-banner tone="info">
            <s-heading>{t("segments.offHeading")}</s-heading>
            <s-paragraph>{t("segments.offBody")}</s-paragraph>
          </s-banner>
        )}

        {view.failure ? (
          <s-banner tone="warning">
            <s-heading>{t(`segments.failure.${view.failure}.heading`)}</s-heading>
            <s-paragraph>{t(`segments.failure.${view.failure}.body`)}</s-paragraph>
          </s-banner>
        ) : null}

        <form method="post">
          <input type="hidden" name="intent" value="draft" />
          <s-stack direction="block" gap="small">
            <s-text-field
              name="sentence"
              label={t("segments.sentenceLabel")}
              details={t("segments.sentenceHelp")}
              value={view.sentence}
              {...whenDisabled(!view.aiAvailable)}
            />
            <s-button
              type="submit"
              variant="primary"
              {...whenDisabled(!view.aiAvailable)}
            >
              {t("segments.draftAction")}
            </s-button>
          </s-stack>
        </form>

        <s-stack direction="block" gap="small-100">
          <s-text color="subdued">{t("segments.examplesHeading")}</s-text>
          {view.examples.map((example) => (
            <s-text key={example} color="subdued">
              “{example}”
            </s-text>
          ))}
        </s-stack>
      </s-stack>
    </s-section>
  );
}

/* -------------------------------------------------------------------------- */

function Draft({ view, draft }: { view: SegmentsView; draft: SegmentDraftView }) {
  const { t } = useTranslation();
  const blocked = draft.clarifications.length > 0;

  return (
    <s-section heading={t("segments.draftHeading")}>
      <s-stack direction="block" gap="base">
        <s-banner tone="info">
          <s-paragraph>{t("segments.draftIntro")}</s-paragraph>
        </s-banner>

        <Chips draft={draft} />

        {draft.notes ? (
          <s-stack direction="block" gap="small-100">
            <s-text color="subdued">{t("segments.notesHeading")}</s-text>
            <s-paragraph color="subdued">{draft.notes}</s-paragraph>
          </s-stack>
        ) : null}

        {blocked ? <Clarifications draft={draft} /> : <Count draft={draft} />}

        {view.saveError ? (
          <s-banner tone="critical">
            <s-heading>{t(`segments.saveError.${view.saveError}Heading`)}</s-heading>
            <s-paragraph>{t(`segments.saveError.${view.saveError}Body`)}</s-paragraph>
          </s-banner>
        ) : null}

        <form method="post">
          <input type="hidden" name="intent" value="save" />
          <input type="hidden" name="draft" value={draft.payload} />
          <s-stack direction="inline" gap="small" alignItems="end">
            <s-text-field
              name="name"
              label={t("segments.nameLabel")}
              value={draft.name}
            />
            <s-button
              type="submit"
              variant="primary"
              {...whenDisabled(blocked || draft.count === 0)}
            >
              {t("segments.saveAction")}
            </s-button>
          </s-stack>
        </form>
      </s-stack>
    </s-section>
  );
}

function Chips({ draft }: { draft: SegmentDraftView }) {
  const { t } = useTranslation();

  return (
    <s-stack direction="inline" gap="small-100">
      {draft.chips.map((chip) => (
        <Chip key={chip.index} chip={chip} draft={draft} />
      ))}
      {draft.chips.length === 0 ? (
        <s-text color="subdued">{t("segments.noChips")}</s-text>
      ) : null}
    </s-stack>
  );
}

function Chip({ chip, draft }: { chip: SegmentChipView; draft: SegmentDraftView }) {
  const { t } = useTranslation();

  return (
    // A form per chip, so removing one works without JavaScript and the whole
    // draft comes back with it — "editable after generation" means editable,
    // not "regenerate and hope".
    <form method="post">
      <input type="hidden" name="intent" value="remove" />
      <input type="hidden" name="draft" value={draft.payload} />
      <input type="hidden" name="index" value={String(chip.index)} />
      <s-stack direction="inline" gap="small-500" alignItems="center">
        <s-badge tone={chip.loosen ? "warning" : "neutral"}>{chip.label}</s-badge>
        <s-button type="submit" variant="tertiary">
          {t("segments.removeChip", { condition: chip.label })}
        </s-button>
      </s-stack>
    </form>
  );
}

function Count({ draft }: { draft: SegmentDraftView }) {
  const { t } = useTranslation();

  if (draft.count === null) return null;

  if (draft.count === 0) {
    const loosen = draft.chips.find((chip) => chip.loosen);
    return (
      <s-banner tone="warning">
        <s-heading>{t("segments.emptyHeading")}</s-heading>
        <s-paragraph>
          {loosen
            ? t("segments.emptyLoosen", { condition: loosen.label })
            : t("segments.emptyNoHelp")}
        </s-paragraph>
      </s-banner>
    );
  }

  return (
    <s-stack direction="block" gap="small-100">
      <s-heading>{t("segments.count", { count: draft.count })}</s-heading>
      {/* The count is a claim until somebody can see who is in it. */}
      <s-unordered-list>
        {draft.samples.map((sample) => (
          <s-list-item key={sample.id}>{sample.name}</s-list-item>
        ))}
      </s-unordered-list>
    </s-stack>
  );
}

function Clarifications({ draft }: { draft: SegmentDraftView }) {
  const { t } = useTranslation();

  return (
    <s-stack direction="block" gap="small">
      <s-banner tone="warning">
        <s-heading>{t("segments.clarifyHeading")}</s-heading>
        <s-paragraph>{t("segments.clarifyBody")}</s-paragraph>
      </s-banner>

      {draft.clarifications.map((clarification) => (
        <s-stack key={clarification.index} direction="block" gap="small-100">
          <s-text>
            {t(
              clarification.options.length > 0
                ? "segments.whichOne"
                : "segments.noSuchGroup",
              { term: clarification.term },
            )}
          </s-text>
          <s-stack direction="inline" gap="small-100">
            {clarification.options.map((option) => (
              <form key={option.id} method="post">
                <input type="hidden" name="intent" value="answer" />
                <input type="hidden" name="draft" value={draft.payload} />
                <input type="hidden" name="term" value={clarification.term} />
                <input type="hidden" name="choice" value={option.id} />
                <s-button type="submit">{option.label}</s-button>
              </form>
            ))}
          </s-stack>
        </s-stack>
      ))}
    </s-stack>
  );
}

/* -------------------------------------------------------------------------- */

function Saved({ view }: { view: SegmentsView }) {
  const { t } = useTranslation();

  if (view.saved.length === 0) {
    return (
      <s-section heading={t("segments.savedHeading")}>
        <s-paragraph color="subdued">{t("segments.savedEmpty")}</s-paragraph>
      </s-section>
    );
  }

  return (
    <s-section heading={t("segments.savedHeading")}>
      <s-table>
        <s-table-header-row>
          <s-table-header>{t("segments.colName")}</s-table-header>
          <s-table-header>{t("segments.colConditions")}</s-table-header>
          <s-table-header>{t("segments.colMembers")}</s-table-header>
          <s-table-header>{t("segments.colActions")}</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {view.saved.map((segment) => (
            <s-table-row key={segment.id}>
              <s-table-cell>
                <s-stack direction="inline" gap="small-500" alignItems="center">
                  <s-text>{segment.name}</s-text>
                  {segment.fromSentence ? <s-badge tone="info">✦</s-badge> : null}
                </s-stack>
              </s-table-cell>
              <s-table-cell>
                {t("segments.conditionCount", { count: segment.conditionCount })}
              </s-table-cell>
              <s-table-cell>
                {/* "As of", never "now": a saved segment's count is a snapshot
                    and saying otherwise would be a number nobody can trust. */}
                {segment.lastCount === null || segment.lastCountAt === null
                  ? t("segments.neverCounted")
                  : t("segments.membersAsOf", {
                      count: segment.lastCount,
                      when: segment.lastCountAt.slice(0, 10),
                    })}
              </s-table-cell>
              <s-table-cell>
                <form method="post">
                  <input type="hidden" name="intent" value="delete" />
                  <input type="hidden" name="id" value={segment.id} />
                  <s-button type="submit" tone="critical" variant="tertiary">
                    {t("segments.delete")}
                  </s-button>
                </form>
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    </s-section>
  );
}
