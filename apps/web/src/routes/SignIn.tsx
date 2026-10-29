import { login, register } from "@gem/shared/contracts";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Form } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { api } from "../api/client.ts";
import { useSetMe } from "../auth.tsx";
import { Button, Card, ErrorMessage, errorText, TextField } from "../ui/controls.tsx";
import { useDocumentTitle, useLive } from "../ui/live.tsx";

export function SignInPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("auth:signIn.title"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const setMe = useSetMe();
  const navigate = useNavigate();
  const { announce } = useLive();
  const mutation = useMutation({
    mutationFn: () => api.call(login, { body: { email, password } }),
    onSuccess: async ({ user }) => {
      setMe(user);
      announce(t("auth:signedIn", { name: user.displayName }));
      await navigate({ to: "/" });
    },
    onError: (e) => announce(errorText(t, e)),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    mutation.mutate();
  }

  return (
    <>
      <h1>{t("auth:signIn.title")}</h1>
      <Card>
        <Form onSubmit={submit}>
          <TextField
            label={t("auth:email")}
            type="email"
            name="email"
            autoComplete="username"
            value={email}
            onChange={setEmail}
            isRequired
          />
          <TextField
            label={t("auth:password")}
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
            isRequired
          />
          <ErrorMessage error={mutation.error} />
          <Button type="submit" isDisabled={mutation.isPending}>
            {t("auth:signIn.submit")}
          </Button>
        </Form>
      </Card>
      <p>
        {t("auth:signIn.noAccount")} <Link to="/register">{t("auth:register.link")}</Link>
      </p>
    </>
  );
}

export function RegisterPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("auth:register.title"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const setMe = useSetMe();
  const navigate = useNavigate();
  const { announce } = useLive();
  const mutation = useMutation({
    mutationFn: () => api.call(register, { body: { email, password, displayName } }),
    onSuccess: async ({ user }) => {
      setMe(user);
      announce(t("auth:registered", { name: user.displayName }));
      await navigate({ to: "/" });
    },
    onError: (e) => announce(errorText(t, e)),
  });

  return (
    <>
      <h1>{t("auth:register.title")}</h1>
      <Card>
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
        >
          <TextField
            label={t("auth:displayName")}
            name="displayName"
            autoComplete="name"
            value={displayName}
            onChange={setDisplayName}
            isRequired
          />
          <TextField
            label={t("auth:email")}
            type="email"
            name="email"
            autoComplete="email"
            value={email}
            onChange={setEmail}
            isRequired
          />
          <TextField
            label={t("auth:password")}
            description={t("auth:passwordRules")}
            type="password"
            name="password"
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
            isRequired
          />
          <ErrorMessage error={mutation.error} />
          <Button type="submit" isDisabled={mutation.isPending}>
            {t("auth:register.submit")}
          </Button>
        </Form>
      </Card>
      <p>
        {t("auth:register.haveAccount")} <Link to="/sign-in">{t("auth:signIn.link")}</Link>
      </p>
    </>
  );
}
