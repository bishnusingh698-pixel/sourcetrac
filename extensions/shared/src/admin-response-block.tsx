/** @jsxImportSource preact */
import { useEffect, useState } from "preact/hooks";

/**
 * Shared body for the two admin block extensions (Phase 7).
 *
 * Both the order-details and customer-details blocks answer the same question
 * for the merchant: "what did this buyer say?" They differ only in which id
 * they pass. Rendering them from one component keeps the fetch, the error
 * handling and the "no answer" copy identical.
 *
 * Auth: the request goes to our own app domain, so the host adds an
 * `Authorization: Bearer <idToken>` header automatically; passing the token
 * explicitly via `auth.idToken()` keeps it working on any host. The backend
 * verifies it (app/lib/id-token.server.ts) — the id sent in the body is only a
 * lookup key, never what grants access.
 */

export type AdminContext = {
  orderId: string | null;
  customerId: string | null;
};

type AdminAnswer = {
  found: boolean;
  channelLabel: string | null;
  surveyName: string | null;
  submittedAt: string | null;
};

/** Strip the numeric tail from a GID; leave a bare number untouched. */
export function numericId(gid: string | undefined | null): string | null {
  if (!gid) return null;
  const match = gid.match(/(\d+)$/);
  return match?.[1] ?? null;
}

export function AdminResponseBlock({
  apiUrl,
  getToken,
  context,
  heading,
  missing,
  unavailable,
  loading: loadingLabel,
  foundPrefix,
}: {
  apiUrl: string;
  getToken: () => Promise<string | null>;
  context: AdminContext;
  heading: string;
  missing: string;
  /** Shown when the lookup failed (auth, rate limit, server): not "no answer". */
  unavailable: string;
  loading: string;
  foundPrefix: string;
}) {
  const [loading, setLoading] = useState(true);
  const [answer, setAnswer] = useState<AdminAnswer | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Inside the try: a rejected `idToken()` used to leave the block
        // spinning forever.
        const token = await getToken();
        if (!token) throw new Error("No ID token");
        const res = await fetch(`${apiUrl}/api/admin-survey-context`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(context),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const result = (await res.json()) as AdminAnswer;
        if (!cancelled) setAnswer(result);
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiUrl, context.orderId, context.customerId]);

  return (
    <s-admin-block heading={heading}>
      {loading ? (
        <s-text>{loadingLabel}</s-text>
      ) : failed ? (
        <s-text>{unavailable}</s-text>
      ) : answer && answer.found && answer.channelLabel ? (
        <s-text>
          {foundPrefix} <s-text type="strong">{answer.channelLabel}</s-text>
        </s-text>
      ) : (
        <s-text>{missing}</s-text>
      )}
    </s-admin-block>
  );
}
