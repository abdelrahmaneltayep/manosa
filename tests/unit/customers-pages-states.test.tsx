import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { CustomerDetailPage } from "~/components/customers/CustomerDetailPage";
import { CustomerListPage } from "~/components/customers/CustomerListPage";
import { GroupDetailPage } from "~/components/customers/GroupDetailPage";
import { GroupListPage } from "~/components/customers/GroupListPage";
import { TagRulesPage } from "~/components/customers/TagRulesPage";
import type {
  CustomerDetailView,
  CustomerListView,
  CustomerRowView,
  GroupDetailView,
  GroupListView,
  GroupRowView,
  TagRuleListView,
  TagRuleRowView,
} from "~/components/customers/types";
import type { Locale } from "~/i18n/config";
import { createCaptureHarness, type CaptureHarness } from "../support/state-capture";

/**
 * Every state in checklist §3, rendered and asserted.
 *
 * QA_CAPTURE=1 also writes each one to qa/2.1/, which the Playwright pass then
 * screenshots. The captures are structure only — see the note each one carries.
 */

const OUT = resolve(process.cwd(), "qa/2.1");

let harness: CaptureHarness;
const render = (node: React.ReactNode, locale: Locale = "en") =>
  harness.render(node, locale);
const capture = (name: string, html: string, locale: Locale = "en") =>
  harness.capture(name, html, locale);

beforeAll(async () => {
  harness = await createCaptureHarness({
    title: "Customers",
    outFor: () => OUT,
    dirs: [OUT],
  });
});

/* -------------------------------------------------------------------------- */

const row = (overrides: Partial<CustomerRowView> = {}): CustomerRowView => ({
  id: "c1",
  name: "Acme Ltd",
  email: "buyer@acme.test",
  group: { id: "g1", name: "Gold", color: null },
  terms: "Net 30 days",
  lifetimeSpend: "$1,200.50",
  orderCount: 4,
  lastOrderAt: "2026-05-22T00:00:00.000Z",
  daysSinceLastOrder: 10,
  atRisk: false,
  taxExempt: false,
  status: "APPROVED",
  tags: ["wholesale", "gold"],
  deletedInShopify: false,
  dueToReorder: false,
  ...overrides,
});

const listView = (overrides: Partial<CustomerListView> = {}): CustomerListView => ({
  rows: [],
  total: 0,
  page: 1,
  pageSize: 50,
  totalUnfiltered: 0,
  search: "",
  filters: { groupId: "", terms: "", taxExempt: "", atRisk: false },
  groups: [{ id: "g1", name: "Gold" }],
  syncing: false,
  syncedSoFar: 0,
  staleMinutesAgo: null,
  orphanedCount: 0,
  wholesaleTag: "wholesale",
  atRiskDays: 60,
  aiAvailable: false,
  ...overrides,
});

const groupRow = (overrides: Partial<GroupRowView> = {}): GroupRowView => ({
  id: "g1",
  name: "Gold",
  handle: "gold",
  tag: "gold",
  color: null,
  memberCount: 12,
  terms: "Net 30 days",
  pricingRuleCount: 2,
  ...overrides,
});

const groupListView = (overrides: Partial<GroupListView> = {}): GroupListView => ({
  rows: [],
  templates: [
    { key: "silver", name: "Silver" },
    { key: "gold", name: "Gold" },
  ],
  blockedDelete: null,
  destinations: [],
  error: null,
  ...overrides,
});

const tagRuleRow = (overrides: Partial<TagRuleRowView> = {}): TagRuleRowView => ({
  id: "t1",
  name: "Gold buyers",
  enabled: true,
  priority: 100,
  matchMode: "all",
  conditions: [],
  conditionSummaries: ["Spent $1,000.00 or more"],
  addTags: ["gold"],
  removeTags: ["silver"],
  lastRunAt: null,
  lastMatchCount: null,
  unreadableCount: 0,
  ...overrides,
});

const tagView = (overrides: Partial<TagRuleListView> = {}): TagRuleListView => ({
  rows: [],
  locked: false,
  requiredPlan: null,
  preview: null,
  lastRun: null,
  issues: [],
  ...overrides,
});

/* -------------------------------------------------------------------------- */

describe("buyers list states", () => {
  it("empty — names the tag that makes someone wholesale", () => {
    const html = render(<CustomerListPage view={listView()} />);
    capture("01-buyers-empty", html);

    expect(html).toContain("No wholesale buyers yet");
    // The merchant cannot act on "no buyers" without knowing what counts.
    expect(html).toContain("wholesale");
    expect(html).toContain("Set up a registration form");
  });

  it("first sync — skeleton rows, hidden from assistive tech", () => {
    const html = render(
      <CustomerListPage view={listView({ syncing: true, syncedSoFar: 0 })} />,
    );
    capture("02-buyers-syncing", html);

    expect(html).toContain("Importing your customers from Shopify");
    // Announcing three empty rows is worse than silence. React serialises the
    // prop name verbatim on a custom element; HTML parsing lowercases it.
    expect(html).toContain('accessibilityVisibility="hidden"');
  });

  it("syncing with rows already in — a banner, not a blank page", () => {
    const html = render(
      <CustomerListPage
        view={listView({
          syncing: true,
          syncedSoFar: 240,
          rows: [row()],
          total: 240,
          totalUnfiltered: 240,
        })}
      />,
    );
    capture("03-buyers-syncing-partial", html);

    expect(html).toContain("240 customers imported so far");
    expect(html).toContain("Acme Ltd");
  });

  it("ideal — every column the checklist asks for", () => {
    const html = render(
      <CustomerListPage
        view={listView({
          rows: [
            row(),
            row({ id: "c2", name: "Bright Supply", group: null, terms: null }),
          ],
          total: 2,
          totalUnfiltered: 2,
        })}
      />,
    );
    capture("04-buyers-ideal", html);

    expect(html).toContain("Lifetime spend");
    // Two columns headed "Group" is a table nobody can read.
    expect(html).toContain("Change group");
    expect(html).toContain("$1,200.50");
    expect(html).toContain("Net 30 days");
    expect(html).toContain("10 days ago");
  });

  it("badges — at risk, tax-exempt, pending, deleted in Shopify", () => {
    const html = render(
      <CustomerListPage
        view={listView({
          rows: [
            row({ atRisk: true, daysSinceLastOrder: 92 }),
            row({ id: "c2", name: "Pending Co", status: "PENDING" }),
            row({ id: "c3", name: "Exempt Co", taxExempt: true }),
            row({ id: "c4", name: "Gone Ltd", deletedInShopify: true }),
          ],
          total: 4,
          totalUnfiltered: 4,
        })}
      />,
    );
    capture("05-buyers-badges", html);

    expect(html).toContain("At risk");
    expect(html).toContain("Pending");
    expect(html).toContain("Tax-exempt");
    expect(html).toContain("Deleted in Shopify");
  });

  it("a deleted buyer cannot be moved between groups", () => {
    const html = render(
      <CustomerListPage
        view={listView({
          rows: [row({ deletedInShopify: true })],
          total: 1,
          totalUnfiltered: 1,
        })}
      />,
    );
    // Offering a control that cannot work is worse than not offering it.
    expect(html).toContain("disabled");
    // And nothing on that row should promise a future price for someone
    // Shopify no longer has.
    expect(html).not.toContain("next visit to your store");
  });

  it("never predicts a reorder before the model behind it exists", () => {
    const html = render(
      <CustomerListPage
        view={listView({ rows: [row()], total: 1, totalUnfiltered: 1 })}
      />,
    );
    expect(html).not.toContain("Due to reorder");
  });

  it("no results — different words from the empty state", () => {
    const html = render(
      <CustomerListPage
        view={listView({ rows: [], total: 0, totalUnfiltered: 40, search: "zzz" })}
      />,
    );
    capture("06-buyers-no-results", html);

    expect(html).toContain("Nothing matched “zzz”");
    expect(html).not.toContain("No wholesale buyers yet");
  });

  it("orphaned buyers — says what it means for their price", () => {
    const html = render(
      <CustomerListPage
        view={listView({
          rows: [row({ group: null, terms: null })],
          total: 1,
          totalUnfiltered: 1,
          orphanedCount: 3,
        })}
      />,
    );
    capture("07-buyers-orphaned", html);

    expect(html).toContain("3 buyers have no group");
    expect(html).toContain("priced by their tags alone");
  });

  it("stale — admits the list is our copy, and offers a retry", () => {
    const html = render(
      <CustomerListPage
        view={listView({
          rows: [row()],
          total: 1,
          totalUnfiltered: 1,
          staleMinutesAgo: 9,
        })}
      />,
    );
    capture("08-buyers-stale", html);

    expect(html).toContain("Showing what we have on file");
    expect(html).toContain("9 minutes ago");
  });

  it("paginated — 50 a page, with a range the merchant can read", () => {
    const html = render(
      <CustomerListPage
        view={listView({
          rows: [row()],
          total: 1240,
          totalUnfiltered: 1240,
          page: 2,
        })}
      />,
    );
    capture("09-buyers-paginated", html);

    expect(html).toContain("51–100 of 1240");
    expect(html).toContain("page=3");
  });

  it("the segment builder is offered but disabled until the AI layer lands", () => {
    const html = render(
      <CustomerListPage
        view={listView({ rows: [row()], total: 1, totalUnfiltered: 1 })}
      />,
    );
    capture("10-buyers-ai-not-ready", html);

    expect(html).toContain("✦ Build a segment");
    expect(html).toContain("disabled");
  });

  it("warns that a tier change only reaches the buyer next session", () => {
    const html = render(
      <CustomerListPage
        view={listView({ rows: [row()], total: 1, totalUnfiltered: 1 })}
      />,
    );
    expect(html).toContain("next visit to your store");
  });
});

describe("group states", () => {
  it("empty — two starter tiers, one click", () => {
    const html = render(<GroupListPage view={groupListView()} />);
    capture("11-groups-empty", html);

    expect(html).toContain("No groups yet");
    expect(html).toContain("Silver");
    expect(html).toContain("Create 2 starter tiers");
  });

  it("ideal — flags a tier with no pricing attached", () => {
    const html = render(
      <GroupListPage
        view={groupListView({
          rows: [groupRow(), groupRow({ id: "g2", name: "Silver", pricingRuleCount: 0 })],
          templates: [],
        })}
      />,
    );
    capture("12-groups-ideal", html);

    // A tier with no pricing is a label, not a tier.
    expect(html).toContain("No pricing attached");
    expect(html).toContain("2 rules");
  });

  it("delete guard — asks where the members go before deleting", () => {
    const html = render(
      <GroupListPage
        view={groupListView({
          rows: [groupRow()],
          templates: [],
          blockedDelete: { id: "g1", name: "Gold", memberCount: 12 },
          destinations: [{ id: "g2", name: "Silver" }],
        })}
      />,
    );
    capture("13-groups-delete-blocked", html);

    expect(html).toContain("still has 12 members");
    expect(html).toContain("Move members to");
    // "No group" is a decision with a price consequence, so it is offered
    // explicitly rather than happening by default.
    expect(html).toContain("price them on their tags alone");
  });

  it("duplicate name — explains why it matters", () => {
    const html = render(
      <GroupListPage
        view={groupListView({
          rows: [groupRow()],
          templates: [],
          error: "duplicate_handle",
        })}
      />,
    );
    capture("14-groups-duplicate", html);

    expect(html).toContain("That name is already taken");
    expect(html).toContain("which one a pricing rule means");
  });

  it("group page — the whole bundle, with unbuilt sections labelled", () => {
    const view: GroupDetailView = {
      group: { ...groupRow(), description: "Our best resellers" },
      sections: [
        {
          key: "pricing",
          href: "/app/pricing?search=gold",
          summary: "2 live rules price the “gold” tag.",
          comingIn: null,
        },
        { key: "limits", href: null, summary: "No order minimum.", comingIn: "3.1" },
        { key: "terms", href: null, summary: "Net 30.", comingIn: "3.2" },
        { key: "shipping", href: null, summary: "No shipping rule.", comingIn: "3.2" },
        {
          key: "visibility",
          href: null,
          summary: "Sees the whole catalogue.",
          comingIn: "3.4",
        },
      ],
      members: [row()],
      memberTotal: 12,
      page: 1,
      pageSize: 50,
      saving: false,
      error: null,
    };
    const html = render(<GroupDetailPage view={view} />);
    capture("15-group-bundle", html);

    expect(html).toContain("What this tier includes");
    // A merchant who sets a limit nothing enforces finds out from an order.
    expect(html).toContain("Arrives in phase 3.1");
    expect(html).toContain("Open pricing rules");
  });

  it("group page paginates a tier with more members than fit", () => {
    const view: GroupDetailView = {
      group: { ...groupRow(), memberCount: 312, description: null },
      sections: [],
      members: [row()],
      memberTotal: 312,
      page: 2,
      pageSize: 50,
      saving: false,
      error: null,
    };
    const html = render(<GroupDetailPage view={view} />);
    capture("31-group-paginated", html);

    // Showing the first fifty with no hint the rest exist is how a merchant
    // concludes a tier lost two hundred members.
    expect(html).toContain("51–100 of 312");
    expect(html).toContain("?page=3");
  });

  it("group page with no members yet", () => {
    const view: GroupDetailView = {
      group: { ...groupRow(), memberCount: 0, description: null, pricingRuleCount: 0 },
      sections: [],
      members: [],
      memberTotal: 0,
      page: 1,
      pageSize: 50,
      saving: false,
      error: null,
    };
    const html = render(<GroupDetailPage view={view} />);
    capture("16-group-no-members", html);

    expect(html).toContain("Nobody is in this group yet");
  });
});

describe("buyer page states", () => {
  const detail = (
    overrides: Partial<CustomerDetailView["customer"]> = {},
    rest: Partial<CustomerDetailView> = {},
  ): CustomerDetailView => ({
    customer: {
      ...row(),
      firstName: "Sam",
      lastName: "Reed",
      company: "Acme Ltd",
      phone: "+966500000000",
      countryCode: "SA",
      vatNumber: null,
      vatVerifiedAt: null,
      internalNote: null,
      currencyCode: "USD",
      syncedAt: "2026-06-01T12:00:00.000Z",
      ...overrides,
    },
    groups: [{ id: "g1", name: "Gold" }],
    knownTags: ["gold", "silver", "wholesale"],
    vatRequired: false,
    saving: false,
    ...rest,
  });

  it("ideal — group, tags, tax and a staff-only note", () => {
    const html = render(<CustomerDetailPage view={detail()} />);
    capture("17-buyer-detail", html);

    expect(html).toContain("Internal note");
    expect(html).toContain("Only your staff sees this");
    expect(html).toContain("as recorded by Shopify");
  });

  it("an unverified VAT id is not called invalid", () => {
    const html = render(<CustomerDetailPage view={detail({ vatNumber: "SA123456" })} />);
    capture("18-buyer-vat-unverified", html);

    // A VIES outage must never brand a real buyer as fraudulent.
    expect(html).toContain("VAT id not verified yet");
    expect(html).not.toContain("invalid");
  });

  it("tax exemption refused for want of a VAT id", () => {
    const html = render(<CustomerDetailPage view={detail({}, { vatRequired: true })} />);
    capture("19-buyer-vat-required", html);

    expect(html).toContain("A VAT id is needed first");
  });

  it("deleted in Shopify — the record stays, the controls do not", () => {
    const html = render(<CustomerDetailPage view={detail({ deletedInShopify: true })} />);
    capture("20-buyer-deleted", html);

    expect(html).toContain("This customer was deleted in Shopify");
    expect(html).toContain("disabled");
  });
});

describe("auto-tagging states", () => {
  it("empty — says a tag changes what someone pays", () => {
    const html = render(<TagRulesPage view={tagView()} />);
    capture("21-tagging-empty", html);

    expect(html).toContain("No tagging rules yet");
    expect(html).toContain("changes what someone pays");
  });

  it("locked — a teaser, with the existing tags still working", () => {
    const html = render(
      <TagRulesPage view={tagView({ locked: true, requiredPlan: "pro" })} />,
    );
    capture("22-tagging-locked", html);

    expect(html).toContain("not on your plan");
    expect(html).toContain("keep working");
    // The teaser must not offer a builder the server would refuse.
    expect(html).not.toContain("Create rule");
  });

  it("ideal — never-run is not zero matches", () => {
    const html = render(<TagRulesPage view={tagView({ rows: [tagRuleRow()] })} />);
    capture("23-tagging-ideal", html);

    expect(html).toContain("Not run yet");
    expect(html).toContain("Spent $1,000.00 or more");
  });

  it("preview — the count is inspectable, not a claim", () => {
    const html = render(
      <TagRulesPage
        view={tagView({
          rows: [tagRuleRow()],
          preview: {
            examined: 412,
            changed: 84,
            samples: [{ name: "Acme Ltd", add: ["gold"], remove: [] }],
          },
        })}
      />,
    );
    capture("24-tagging-preview", html);

    expect(html).toContain("84 buyers would change");
    expect(html).toContain("Nothing has been written");
    expect(html).toContain("Acme Ltd");
  });

  it("preview with nothing to do", () => {
    const html = render(
      <TagRulesPage
        view={tagView({
          rows: [tagRuleRow()],
          preview: { examined: 412, changed: 0, samples: [] },
        })}
      />,
    );
    capture("25-tagging-preview-none", html);

    expect(html).toContain("Nothing would change");
  });

  it("after a run that could not update everyone", () => {
    const html = render(
      <TagRulesPage
        view={tagView({
          rows: [tagRuleRow({ lastMatchCount: 84, lastRunAt: "2026-06-01T12:00:00Z" })],
          lastRun: { changed: 82, failed: 2, examined: 412 },
        })}
      />,
    );
    capture("26-tagging-ran-with-failures", html);

    expect(html).toContain("82 buyers updated");
    expect(html).toContain("2 buyers could not be updated");
  });

  it("a rule with an unreadable condition is held back, not run partially", () => {
    const html = render(
      <TagRulesPage view={tagView({ rows: [tagRuleRow({ unreadableCount: 1 })] })} />,
    );
    capture("27-tagging-unreadable", html);

    // Missing a condition, a rule matches more people than it was written to.
    expect(html).toContain("held back");
  });

  it("validation — refuses a rule that would match nobody", () => {
    const html = render(
      <TagRulesPage view={tagView({ issues: [{ code: "no_conditions" }] })} />,
    );
    capture("28-tagging-invalid", html);

    expect(html).toContain("matches nobody");
  });
});

describe("Arabic", () => {
  it("renders the buyers list right to left, with Arabic plurals", () => {
    const html = render(
      <CustomerListPage
        view={listView({
          // The terms string is built by the loader through the same catalog,
          // so the fixture carries the Arabic one — an English "Net 30 days"
          // sitting in this capture would misrepresent the page.
          rows: [row({ daysSinceLastOrder: 3, terms: "الدفع خلال 30 يوم" })],
          total: 1,
          totalUnfiltered: 1,
          orphanedCount: 2,
        })}
      />,
      "ar",
    );
    capture("29-buyers-arabic", html, "ar");

    expect(html).toContain("مشترو الجملة");
    // Two of anything is the dual in Arabic, not a plural with a 2 in front.
    expect(html).toContain("مشتريان بلا مجموعة");
    expect(html).toContain("قبل 3 أيام");
    expect(html).not.toContain("Wholesale buyers");
  });

  it("renders the groups page in Arabic", () => {
    const html = render(
      <GroupListPage view={groupListView({ rows: [groupRow()], templates: [] })} />,
      "ar",
    );
    capture("30-groups-arabic", html, "ar");

    expect(html).toContain("مجموعات العملاء");
    expect(html).not.toContain("Customer groups");
  });
});
