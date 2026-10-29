// Nothing here may be flagged by no-literal-ui-string (SPEC §11.6, "What it never flags").
declare const n: number;
declare const ok: boolean;
declare const status: string;
declare const question: { text: string; options: string[] };
declare function t(key: string, params?: Record<string, unknown>): string;
declare const i18n: { t: (key: string) => string };
declare function Trans(props: Record<string, unknown>): null;
declare function notify(message: string): void;
declare function announce(message: string): void;

export function Valid() {
  return (
    <main className="layout wide" id="main" lang="en" dir="ltr">
      <a href="/tests" rel="noopener" target="_blank">
        {t("nav.tests")}
      </a>
      <img src="/logo.svg" alt="" />
      <input type="email" name="email" autoComplete="email" inputMode="email" form="login" />
      <label htmlFor="email">{t("auth.email")}</label>
      <div role="status" data-testid="status-region" data-state="idle" aria-labelledby="h1" aria-describedby="d1" aria-controls="c1" />
      <form method="post" />
      <p>{i18n.t("home.title")}</p>
      <p>{t("score", { n })}</p>
      <Trans i18nKey="import.help" />
      <p>{question.text}</p>
      <ul>
        {question.options.map((o) => (
          <li key={o}>{o}</li>
        ))}
      </ul>
      <p>{n}</p>
      <p>{`${n}%`}</p>
      <p> · </p>
      <p>—</p>
      <p>{"/"}</p>
      <p>12:30</p>
      <p>%</p>
      <p>gem-proctor</p>
      <p>KaTeX · LaTeX · Markdown</p>
      <p>JSON / CSV</p>
      <p>{ok ? t("yes") : t("no")}</p>
      {status === "open" && <p>{t("open")}</p>}
      {/* biome-ignore lint/plugin: fixture for the reason-bearing suppression comment */}
      <p>Suppressed with a reason</p>
    </main>
  );
}

notify(t("saved"));
announce(t("import.previewReady", { count: n }));
document.title = t("title.results");
const notUi = "plain string outside JSX";
export { notUi };
