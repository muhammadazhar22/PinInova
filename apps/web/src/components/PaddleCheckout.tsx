"use client";

import Script from "next/script";
import { useRef, useState } from "react";
import type { CheckoutConfig } from "@/modules/billing/paddle";

interface PaddleJs {
  Environment: { set(env: "sandbox"): void };
  Initialize(o: { token: string }): void;
  Checkout: { open(o: Record<string, unknown>): void };
}
declare global {
  interface Window { Paddle?: PaddleJs; __paddleReady?: boolean }
}

/**
 * Opens Paddle's overlay checkout (SPEC-081). `config` comes from the server (checkoutConfig) with the signed org id;
 * the number of extra accounts is read from the surrounding form's `extra` field.
 */
export function PaddleCheckoutButton({ config, extraPriceId, successUrl, label = "Checkout" }: { config: CheckoutConfig; extraPriceId?: string; successUrl: string; label?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | null>(null);

  function open() {
    const P = window.Paddle;
    if (!P) return setError("The payment window could not load. Check your connection and try again.");
    if (!window.__paddleReady) {
      if (config.environment === "sandbox") P.Environment.set("sandbox");
      P.Initialize({ token: config.token });
      window.__paddleReady = true;
    }
    const field = ref.current?.form?.elements.namedItem("extra") as HTMLInputElement | null;
    const extra = Math.max(0, Math.min(200, Math.floor(Number(field?.value || 0))));
    const items = [...config.items, ...(extraPriceId && extra > 0 ? [{ priceId: extraPriceId, quantity: extra }] : [])];
    P.Checkout.open({ items, customData: config.customData, customer: config.customer, settings: { successUrl } });
  }

  return (
    <>
      <Script src="https://cdn.paddle.com/paddle/v2/paddle.js" strategy="afterInteractive" />
      <button ref={ref} type="button" className="btn-primary mt-3" onClick={open}>{label}</button>
      {error && <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}
    </>
  );
}
