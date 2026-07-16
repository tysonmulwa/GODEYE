"use client";

import { motion } from "framer-motion";
import { Eye, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { businessProfileSchema } from "@godeye/shared";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { Button, Card, ErrorNote, Input, Label, Textarea } from "@/components/ui";

const GOAL_OPTIONS = [
  "Grow social media following",
  "Increase website traffic",
  "Generate more leads",
  "Boost online sales",
  "Build brand awareness",
  "Improve customer engagement",
];

export default function OnboardingPage() {
  const router = useRouter();
  const { status, organization, markProfileComplete } = useAuthStore();
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    businessName: "",
    industry: "",
    description: "",
    targetAudience: "",
    location: "",
    website: "",
    products: "",
    services: "",
    goals: [] as string[],
    brandVoice: "",
    competitors: "",
    seasonalNotes: "",
  });

  useEffect(() => {
    if (status === "guest") router.replace("/login");
    if (status === "authed" && organization?.hasProfile) router.replace("/dashboard");
    if (organization && !form.businessName) {
      setForm((f) => ({ ...f, businessName: organization.name }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, organization]);

  if (status !== "authed") {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-ink-3" />
      </div>
    );
  }

  const set =
    (key: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  const toggleGoal = (goal: string) =>
    setForm((f) => ({
      ...f,
      goals: f.goals.includes(goal) ? f.goals.filter((g) => g !== goal) : [...f.goals, goal],
    }));

  const csv = (value: string) =>
    value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  const submit = async () => {
    setError(null);
    const payload = {
      businessName: form.businessName,
      industry: form.industry,
      description: form.description,
      targetAudience: form.targetAudience,
      location: form.location,
      website: form.website,
      products: csv(form.products),
      services: csv(form.services),
      goals: form.goals,
      brandVoice: form.brandVoice,
      competitors: csv(form.competitors),
      seasonalNotes: form.seasonalNotes,
    };
    const parsed = businessProfileSchema.safeParse(payload);
    if (!parsed.success) {
      setError(parsed.error.issues[0].message + ` (${parsed.error.issues[0].path.join(".")})`);
      return;
    }
    setSaving(true);
    try {
      await api("/business-profile", { method: "PUT", body: parsed.data });
      markProfileComplete();
      router.replace("/connections?onboarding=1");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const steps = ["Business", "Audience & goals", "Brand"];

  return (
    <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-4 py-10">
      <div className="mb-8 flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-white">
          <Eye className="h-4.5 w-4.5" />
        </div>
        <div>
          <p className="text-sm font-semibold">Set up your marketing brain</p>
          <p className="text-xs text-ink-3">
            The AI uses this profile for everything it creates — be specific.
          </p>
        </div>
      </div>

      <div className="mb-6 flex gap-2">
        {steps.map((label, i) => (
          <div key={label} className="flex-1">
            <div
              className={`h-1 rounded-full ${i <= step ? "bg-accent" : "bg-surface-3"} transition-colors`}
            />
            <p className={`mt-1.5 text-[11px] ${i === step ? "text-ink" : "text-ink-3"}`}>{label}</p>
          </div>
        ))}
      </div>

      <motion.div
        key={step}
        initial={{ opacity: 0, x: 8 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.2 }}
      >
        <Card className="space-y-4">
          {step === 0 && (
            <>
              <div>
                <Label>Business name</Label>
                <Input value={form.businessName} onChange={set("businessName")} />
              </div>
              <div>
                <Label>Industry</Label>
                <Input
                  value={form.industry}
                  onChange={set("industry")}
                  placeholder="e.g. Specialty coffee, SaaS, Real estate"
                />
              </div>
              <div>
                <Label>What does the business do? (min 10 chars)</Label>
                <Textarea
                  rows={4}
                  value={form.description}
                  onChange={set("description")}
                  placeholder="We roast single-origin Kenyan coffee and sell online and in two Nairobi cafés..."
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Location (optional)</Label>
                  <Input value={form.location} onChange={set("location")} placeholder="Nairobi, Kenya" />
                </div>
                <div>
                  <Label>Website (optional)</Label>
                  <Input value={form.website} onChange={set("website")} placeholder="https://..." />
                </div>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <div>
                <Label>Target audience (min 5 chars)</Label>
                <Textarea
                  rows={3}
                  value={form.targetAudience}
                  onChange={set("targetAudience")}
                  placeholder="Coffee lovers aged 25-45 who value quality and sustainability..."
                />
              </div>
              <div>
                <Label>Marketing goals (choose at least one)</Label>
                <div className="flex flex-wrap gap-2">
                  {GOAL_OPTIONS.map((goal) => (
                    <button
                      key={goal}
                      type="button"
                      onClick={() => toggleGoal(goal)}
                      className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                        form.goals.includes(goal)
                          ? "border-accent bg-accent-soft text-accent"
                          : "border-line text-ink-2 hover:border-ink-3"
                      }`}
                    >
                      {goal}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <Label>Products (comma-separated, optional)</Label>
                <Input
                  value={form.products}
                  onChange={set("products")}
                  placeholder="Single-origin beans, Cold brew kits"
                />
              </div>
              <div>
                <Label>Services (comma-separated, optional)</Label>
                <Input value={form.services} onChange={set("services")} placeholder="Catering, Barista training" />
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div>
                <Label>Brand voice (optional but powerful)</Label>
                <Textarea
                  rows={3}
                  value={form.brandVoice}
                  onChange={set("brandVoice")}
                  placeholder="Warm, knowledgeable, a little playful — never corporate."
                />
              </div>
              <div>
                <Label>Competitors (comma-separated, optional)</Label>
                <Input value={form.competitors} onChange={set("competitors")} placeholder="Brand A, Brand B" />
              </div>
              <div>
                <Label>Seasonality notes (optional)</Label>
                <Textarea
                  rows={2}
                  value={form.seasonalNotes}
                  onChange={set("seasonalNotes")}
                  placeholder="December gifting peak; slow season in April..."
                />
              </div>
            </>
          )}

          <ErrorNote message={error} />

          <div className="flex justify-between pt-1">
            <Button variant="ghost" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
              Back
            </Button>
            {step < 2 ? (
              <Button onClick={() => setStep((s) => s + 1)}>Continue</Button>
            ) : (
              <Button onClick={submit} loading={saving}>
                Finish setup
              </Button>
            )}
          </div>
        </Card>
      </motion.div>
    </div>
  );
}
