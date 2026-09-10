import { useTranslation } from "react-i18next";

/** The three Buyer Agent screens: what it may do, a rehearsal, and the log. */
export function AgentTabs({ current }: { current: "guardrails" | "test" | "log" }) {
  const { t } = useTranslation();

  const tabs = [
    { key: "guardrails", href: "/app/storefront-agent" },
    { key: "test", href: "/app/storefront-agent/test" },
    { key: "log", href: "/app/storefront-agent/log" },
  ] as const;

  return (
    <s-stack direction="inline" gap="small" alignItems="center">
      {tabs.map((tab) => (
        <s-link
          key={tab.key}
          href={tab.href}
          {...(tab.key === current ? { "aria-current": "page" } : {})}
        >
          {t(`agent.tab.${tab.key}`)}
        </s-link>
      ))}
    </s-stack>
  );
}
