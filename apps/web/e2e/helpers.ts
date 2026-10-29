import { readFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, type Browser, expect, type Locator, type Page } from "@playwright/test";

export const FIXTURE_PATH = join(import.meta.dirname, "..", "..", "..", "tests", "engr108_chapter1_new_20q_quiz.json");
export const FIXTURE = readFileSync(FIXTURE_PATH, "utf8");
export const FIXED = FIXTURE.replace('"correctAnswer": "1"', '"correctAnswer": "-1"');
export const PASSWORD = "e2e password 123";
const RUN = Math.random().toString(36).slice(2, 8);
export const email = (who: string) => `${who}-${RUN}@example.com`;

/** WCAG 2.2 AA rule set (SPEC §1.3). */
export async function expectNoAxeViolations(page: Page, label: string) {
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa", "best-practice"])
    .analyze();
  const summary = results.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
  );
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

async function api(request: APIRequestContext, method: "get" | "post" | "put", url: string, data?: unknown) {
  const res = await request[method](`/api/v1${url}`, data === undefined ? {} : { data });
  return {
    status: res.status(),
    body: (await res.json().catch(() => null)) as { user?: { id: string; role: string } } | null,
  };
}

/**
 * An admin session. Against a fresh database the first registration is the admin; against an existing
 * stack (Compose), set E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD.
 */
export async function adminRequest(request: APIRequestContext): Promise<{ email: string; password: string }> {
  const envEmail = process.env.E2E_ADMIN_EMAIL;
  const envPassword = process.env.E2E_ADMIN_PASSWORD;
  if (envEmail && envPassword) {
    const r = await api(request, "post", "/auth/login", { email: envEmail, password: envPassword });
    expect(r.status).toBe(200);
    return { email: envEmail, password: envPassword };
  }
  const e = email("admin");
  const r = await api(request, "post", "/auth/register", { email: e, password: PASSWORD, displayName: "Ada Admin" });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body?.user?.role, "the e2e database must be fresh, or set E2E_ADMIN_EMAIL").toBe("admin");
  return { email: e, password: PASSWORD };
}

/** Create a user with a role, using an admin API session. */
export async function createUser(
  admin: APIRequestContext,
  anon: APIRequestContext,
  who: string,
  role: "student" | "proctor",
) {
  const e = email(who);
  const r = await api(anon, "post", "/auth/register", {
    email: e,
    password: PASSWORD,
    displayName: `${who[0]?.toUpperCase()}${who.slice(1)} User`,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  if (role !== "student")
    expect((await api(admin, "put", `/admin/users/${r.body?.user?.id}/roles`, { role })).status).toBe(200);
  return e;
}

export async function newSignedInPage(browser: Browser, userEmail: string, password = PASSWORD): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const r = await page.request.post("/api/v1/auth/login", { data: { email: userEmail, password } });
  expect(r.status()).toBe(200);
  return page;
}

/** Keyboard only: press Tab until `target` has focus. */
export async function tabTo(page: Page, target: Locator, max = 80) {
  const handle = await target.elementHandle();
  for (let i = 0; i < max; i++) {
    if (await page.evaluate((el) => el === document.activeElement, handle)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`could not reach ${target} with Tab`);
}

export async function liveRegionText(page: Page) {
  return (await page.getByTestId("live-region").textContent()) ?? "";
}

/** One question of every type (P1 e2e): weights, partial credit, an ignore list, an explanation and evidence. */
export const PRACTICE_QUIZ = {
  quiz_title: "Practice e2e quiz",
  course: "ENGR108",
  total_questions: 5,
  topics_covered: ["Vectors", "Complexity"],
  questions: [
    {
      id: 1,
      topic: "Vectors",
      question: "Which letter is b?",
      options: ["a", "b", "c", "d"],
      correctAnswer: "b",
      explanation: "Because b is b.",
    },
    {
      id: 2,
      topic: "Complexity",
      question: "How many flops does summing n numbers take?",
      correctAnswer: "n-1",
      ignoreWords: ["flops"],
      points: 2,
    },
    {
      id: 3,
      topic: "Vectors",
      question: "What is seven halves as a decimal?",
      type: "numeric",
      correctAnswer: "3.5",
    },
    {
      id: 4,
      topic: "Complexity",
      question: "Pick the vowels.",
      type: "multi_choice",
      options: ["e", "x", "i", "z"],
      correctAnswer: "e",
      correctAnswers: ["e", "i"],
      partialCredit: "proportional",
    },
    {
      id: 5,
      topic: "Sets",
      question: "The empty set is a subset of every set.",
      type: "true_false",
      options: ["True", "False"],
      correctAnswer: "True",
      evidence: [{ sourceId: "s1", chunkId: "c1", quote: "The empty set is a subset of every set." }],
    },
  ],
};
