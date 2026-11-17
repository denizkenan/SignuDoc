"use client";

import { useEffect, useState } from "react";

// The sites allowed to show SignuDoc's signing page inside their own pages
// (embedded signing, through the API). Administrators only.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";
const EMBED_DOCS_URL =
  "https://github.com/NYLLON-SOFTWARE/SignuDoc/blob/main/docs/api.md#embedded-signing";

type Payload = {
  error?: string;
  origin?: string;
  origins?: Array<{ createdAt: number; origin: string }>;
} | null;

export function EmbeddingPanel() {
  const [origins, setOrigins] = useState<string[] | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch("/api/admin/embed-origins", {
          cache: "no-store",
        });
        const payload = (await response.json().catch(() => null)) as Payload;

        if (!cancelled) {
          if (response.ok && payload?.origins) {
            setOrigins(payload.origins.map((entry) => entry.origin));
          } else {
            setError(payload?.error ?? GENERIC_ERROR_MESSAGE);
          }
        }
      } catch {
        if (!cancelled) {
          setError(GENERIC_ERROR_MESSAGE);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [revision]);

  async function change(method: "DELETE" | "POST", origin: string) {
    setPending(origin);
    setError(null);

    try {
      const response = await fetch(
        method === "DELETE"
          ? `/api/admin/embed-origins?${new URLSearchParams({ origin }).toString()}`
          : "/api/admin/embed-origins",
        method === "DELETE"
          ? { method }
          : {
              body: JSON.stringify({ origin }),
              headers: { "content-type": "application/json" },
              method,
            },
      );
      const payload = (await response.json().catch(() => null)) as Payload;

      if (!response.ok) {
        setError(payload?.error ?? GENERIC_ERROR_MESSAGE);
        return;
      }

      if (method === "POST") {
        setValue("");
      }

      setRevision((current) => current + 1);
    } catch {
      setError(GENERIC_ERROR_MESSAGE);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-5 border-t border-(--border) pt-8">
      <div className="space-y-2">
        <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
          Embedded signing
        </h3>
        <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
          Let an app show the signing page inside its own site, for envelopes it
          sends through the API with{" "}
          <a
            className="font-semibold text-(--accent) underline-offset-4 hover:underline"
            href={EMBED_DOCS_URL}
            rel="noreferrer"
            target="_blank"
          >
            embedded delivery
          </a>
          . No invitations are emailed for those: the app signs the person in
          and says who they are, so list only sites you trust. Every other page
          of SignuDoc stays impossible to frame.
        </p>
      </div>

      <div className="flex max-w-xl flex-wrap items-end gap-3">
        <label className="grid min-w-0 flex-1 gap-1.5">
          <span className="text-[0.8125rem] font-semibold text-(--secondary)">
            Site
          </span>
          <input
            autoComplete="off"
            className="field-input"
            disabled={pending !== null}
            inputMode="url"
            maxLength={255}
            name="embed-origin"
            onChange={(event) => setValue(event.target.value)}
            placeholder="https://app.example.com"
            value={value}
          />
        </label>
        <button
          className="btn-quiet min-h-12 px-5 text-sm"
          disabled={pending !== null || value.trim().length === 0}
          onClick={() => void change("POST", value)}
          type="button"
        >
          {pending === value && value ? "Adding..." : "Allow site"}
        </button>
      </div>

      {error ? (
        <p className="notice notice-danger max-w-2xl" role="alert">
          {error}
        </p>
      ) : null}

      {origins === null ? null : origins.length === 0 ? (
        <p className="text-sm text-(--secondary)">
          No sites yet, so embedded signing is off.
        </p>
      ) : (
        <ul
          aria-label="Sites allowed to embed signing"
          className="grid max-w-2xl gap-2"
        >
          {origins.map((origin) => (
            <li
              className="well flex flex-wrap items-center justify-between gap-2 px-4 py-3"
              key={origin}
            >
              <span className="font-mono text-sm break-all text-(--fg)">
                {origin}
              </span>
              <button
                aria-label={`Remove ${origin}`}
                className="btn-quiet btn-quiet-danger"
                disabled={pending !== null}
                onClick={() => void change("DELETE", origin)}
                type="button"
              >
                {pending === origin ? "Removing..." : "Remove"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
