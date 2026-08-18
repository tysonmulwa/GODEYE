import io

p = "apps/web/src/app/(app)/billing/page.tsx"
s = io.open(p, encoding="utf-8").read()

# ---- types ----
old = """interface PlanRow {
  code: string;
  name: string;
  priceMonthlyUsd: string;
  /** One month bought outright, in the wallet currency's major units. */
  priceOnceMajor: number;
  priceOnceCurrency: string;
  limits: PlanLimits;
}"""
new = """interface PlanRow {
  code: string;
  name: string;
  priceMonthlyUsd: string;
  /** One month on M-Pesa, in shillings. Shown only when M-Pesa is chosen. */
  priceMpesaKes: number;
  limits: PlanLimits;
}"""
assert s.count(old) == 1
s = s.replace(old, new)

old = """  plans: PlanRow[];
  /** Channels a one-off month may use. Empty means wallets are off on this
   *  server, so only the card subscription is offered. */
  oneOffChannels: string[];"""
new = """  plans: PlanRow[];
  /** Ways to pay this server offers, in the order the picker shows them. */
  methods: string[];"""
assert s.count(old) == 1
s = s.replace(old, new)

# ---- imports ----
old = 'import { PayOnPhone } from "@/components/pay-qr";'
new = ('import { PayMethods, type PaymentMethod } from "@/components/pay-methods";\n'
       'import { PayOnPhone } from "@/components/pay-qr";')
assert s.count(old) == 1
s = s.replace(old, new)

# ---- state ----
old = """  /** The open scan-to-pay dialog, if any. */
  const [payOnPhone, setPayOnPhone] = useState<{ url: string; planCode: string } | null>(null);"""
new = """  /** The plan whose payment picker is open, if any. */
  const [choosing, setChoosing] = useState<PlanRow | null>(null);
  /** The open scan-to-pay dialog, if any. */
  const [payOnPhone, setPayOnPhone] = useState<{
    url: string;
    planCode: string;
    method: PaymentMethod;
  } | null>(null);"""
assert s.count(old) == 1
s = s.replace(old, new)

# ---- mutation ----
old = """  const checkout = useMutation({
    mutationFn: ({ planCode, mode }: { planCode: string; mode: "subscription" | "once" }) =>
      // The body is the object itself. api() serialises it, and passing a string
      // here stringified it twice, and the API received a quoted blob instead
      // of a plan code, so every upgrade failed validation.
      api<{ url: string; reference: string | null }>("/billing/checkout", {
        method: "POST",
        body: { planCode, mode },
      }),
    onSuccess: ({ url }, { planCode, mode }) => {
      // A card subscription goes straight to Paystack: it can only be paid on
      // a card anyway, and this device has one. A wallet month opens the QR
      // instead, because the wallet is on a phone that is not this screen.
      if (mode === "subscription") {
        window.location.href = url;
        return;
      }
      setPayOnPhone({ url, planCode });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Could not start checkout"),
  });"""
new = """  const checkout = useMutation({
    mutationFn: ({ planCode, method }: { planCode: string; method: PaymentMethod }) =>
      // The body is the object itself. api() serialises it, and passing a
      // string here stringified it twice, so the API received a quoted blob
      // instead of a plan code and every upgrade failed validation.
      api<{ url: string; reference: string | null }>("/billing/checkout", {
        method: "POST",
        body: { planCode, method },
      }),
    onSuccess: ({ url }, { planCode, method }) => {
      setChoosing(null);
      // A card is paid on this device, which has one. A wallet lives on a
      // phone that is not this screen, so those get the QR.
      if (method === "card") {
        window.location.href = url;
        return;
      }
      setPayOnPhone({ url, planCode, method });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Could not start checkout"),
  });"""
assert s.count(old) == 1, "mutation block not found"
s = s.replace(old, new)

io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("stage 1 ok")
