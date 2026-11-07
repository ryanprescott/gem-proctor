import type { ReactNode } from "react";
import {
  Tab as AriaTab,
  TabList as AriaTabList,
  TabPanel as AriaTabPanel,
  Tabs as AriaTabs,
  type Key,
  type TabPanelProps,
  type TabProps,
} from "react-aria-components";
import styles from "./Tabs.module.css";

/**
 * Tabs (React Aria): one view of a page at a time, for a page that is several things (a source's overview, contents
 * and editing; the LLM page's roles, endpoints and stats). Arrow keys move between tabs; Tab moves into the panel.
 */
export function Tabs({
  label,
  children,
  selectedKey,
  onSelectionChange,
  defaultSelectedKey,
}: {
  label: string;
  children: ReactNode;
  selectedKey?: Key;
  onSelectionChange?: (key: Key) => void;
  defaultSelectedKey?: Key;
}) {
  return (
    <AriaTabs
      className={styles.tabs}
      selectedKey={selectedKey}
      onSelectionChange={onSelectionChange}
      defaultSelectedKey={defaultSelectedKey}
      aria-label={label}
    >
      {children}
    </AriaTabs>
  );
}

export function TabList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <AriaTabList aria-label={label} className={styles.list}>
      {children}
    </AriaTabList>
  );
}

export function Tab({ children, count, ...props }: TabProps & { children: ReactNode; count?: number }) {
  return (
    <AriaTab {...props} className={styles.tab}>
      {children}
      {count !== undefined ? <span className={styles.count}>{count}</span> : null}
    </AriaTab>
  );
}

export function TabPanel(props: TabPanelProps) {
  return <AriaTabPanel {...props} className={styles.panel} />;
}
