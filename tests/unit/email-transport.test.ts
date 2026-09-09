import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canSendEmail,
  configureEmailFromEnv,
  emailSender,
  logTransport,
  NoSenderConfiguredError,
  resendTransport,
  sendEmail,
  setEmailTransport,
  transportFromEnv,
  transportName,
} from "~/lib/email/send.server";

const RESTORE = { ...process.env };

afterEach(() => {
  process.env = { ...RESTORE };
  setEmailTransport(null);
});

const email = {
  to: "buyer@acme.test",
  subject: "Welcome",
  body: "You are in",
  reason: "approved",
};

describe("choosing a transport from the environment", () => {
  it("chooses nothing when nothing is configured", () => {
    delete process.env.MANNON_EMAIL_TRANSPORT;
    delete process.env.MANNON_RESEND_API_KEY;
    expect(transportFromEnv()).toBeNull();
  });

  it("chooses resend when a key is present", () => {
    process.env.MANNON_RESEND_API_KEY = "re_test";
    delete process.env.MANNON_EMAIL_TRANSPORT;
    expect(transportFromEnv()?.name).toBe("resend");
  });

  it("chooses the log transport when asked, key or no key", () => {
    process.env.MANNON_EMAIL_TRANSPORT = "log";
    expect(transportFromEnv()?.name).toBe("log");
  });

  it("refuses to pretend resend is configured without a key", () => {
    process.env.MANNON_EMAIL_TRANSPORT = "resend";
    delete process.env.MANNON_RESEND_API_KEY;
    expect(transportFromEnv()).toBeNull();
  });

  it("registers what it chose", () => {
    process.env.MANNON_EMAIL_TRANSPORT = "log";
    configureEmailFromEnv();
    expect(transportName()).toBe("log");
  });
});

describe("whether anything can be sent at all", () => {
  it("needs both a transport and a From address", () => {
    setEmailTransport(logTransport());
    delete process.env.MANNON_EMAIL_FROM;
    expect(canSendEmail()).toBe(false);

    process.env.MANNON_EMAIL_FROM = "hello@acme.test";
    expect(canSendEmail()).toBe(true);
    expect(emailSender()).toBe("hello@acme.test");
  });

  it("throws rather than quietly dropping a message", async () => {
    setEmailTransport(null);
    process.env.MANNON_EMAIL_FROM = "hello@acme.test";
    // A send that silently does nothing is how a merchant finds out from an
    // applicant who never heard back.
    await expect(sendEmail(email)).rejects.toThrow(NoSenderConfiguredError);
  });
});

describe("the resend transport", () => {
  it("posts the message and the From address", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const transport = resendTransport("re_test", fetchImpl as unknown as typeof fetch);

    await transport.send(email, "hello@acme.test");

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer re_test");
    expect(JSON.parse(init.body as string)).toMatchObject({
      from: "hello@acme.test",
      to: ["buyer@acme.test"],
      subject: "Welcome",
      text: "You are in",
    });
  });

  it("carries the provider's own words into the error", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("domain not verified", { status: 403 }),
    );
    const transport = resendTransport("re_test", fetchImpl as unknown as typeof fetch);

    // A merchant looking at a failed message needs to see why, not "failed".
    await expect(transport.send(email, "hello@acme.test")).rejects.toThrow(
      /403.*domain not verified/,
    );
  });

  it("gives up rather than hanging", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    // A short timeout here; the real one is ten seconds.
    const transport = resendTransport(
      "re_test",
      fetchImpl as unknown as typeof fetch,
      20,
    );

    await expect(transport.send(email, "hello@acme.test")).rejects.toThrow();
  });
});
