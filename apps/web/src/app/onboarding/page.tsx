"use client";

import { motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { GodeyeEmblem } from "@/components/logo";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { businessProfileSchema } from "@godeye/shared";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { Button, Card, ErrorNote, Input, Label, Textarea } from "@/components/ui";

const BUSINESS_GOALS = [
  "Grow social media following",
  "Increase website traffic",
  "Generate more leads",
  "Boost online sales",
  "Build brand awareness",
  "Improve customer engagement",
];

const CREATOR_GOALS = [
  "Grow my audience",
  "Post consistently without burnout",
  "Land brand deals & sponsorships",
  "Monetize my content",
  "Grow my newsletter / community",
  "Build my personal brand",
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
      <div className="flex h-svh items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-ink-3" />
      </div>
    );
  }

  const isCreator = organization?.type === "CREATOR";
  const goalOptions = isCreator ? CREATOR_GOALS : BUSINESS_GOALS;

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

  const steps = [isCreator ? "About you" : "Business", "Audience & goals", "Brand"];

  return (
    <div className="mx-auto flex min-h-svh max-w-xl flex-col justify-center px-4 py-10">
      <div className="mb-8 flex items-center gap-3">
        <GodeyeEmblem variant="compact" style={{ width: 38, height: 38 }} />
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
            <p className={`mt-1.5 text-[14px] ${i === step ? "text-ink" : "text-ink-3"}`}>{label}</p>
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
                <Label>{isCreator ? "Creator / brand name" : "Business name"}</Label>
                <Input value={form.businessName} onChange={set("businessName")} />
              </div>
              <div>
                <Label>{isCreator ? "Niche" : "Industry"}</Label>
                <Input
                  value={form.industry}
                  onChange={set("industry")}
                  placeholder={
                    isCreator
                      ? "e.g. Fitness, Tech reviews, Food & travel, Comedy"
                      : "e.g. Specialty coffee, SaaS, Real estate"
                  }
                />
              </div>
              <div>
                <Label>
                  {isCreator
                    ? "What do you create? (min 10 chars)"
                    : "What does the business do? (min 10 chars)"}
                </Label>
                <Textarea
                  rows={4}
                  value={form.description}
                  onChange={set("description")}
                  placeholder={
                    isCreator
                      ? "I make short-form videos about budget travel across East Africa, plus a weekly newsletter..."
                      : "We roast single-origin Kenyan coffee and sell online and in two Nairobi cafés..."
                  }
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
                <Label>
                  {isCreator ? "Who is your audience? (min 5 chars)" : "Target audience (min 5 chars)"}
                </Label>
                <Textarea
                  rows={3}
                  value={form.targetAudience}
                  onChange={set("targetAudience")}
                  placeholder={
                    isCreator
                      ? "Young professionals who want to travel more on a budget, mostly 20-35..."
                      : "Coffee lovers aged 25-45 who value quality and sustainability..."
                  }
                />
              </div>
              <div>
                <Label>{isCreator ? "Goals (choose at least one)" : "Marketing goals (choose at least one)"}</Label>
                <div className="flex flex-wrap gap-2">
                  {goalOptions.map((goal) => (
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
                <Label>
                  {isCreator
                    ? "Content formats (comma-separated, optional)"
                    : "Products (comma-separated, optional)"}
                </Label>
                <Input
                  value={form.products}
                  onChange={set("products")}
                  placeholder={
                    isCreator
                      ? "Reels, YouTube videos, Newsletter, Podcast"
                      : "Single-origin beans, Cold brew kits"
                  }
                />
              </div>
              <div>
                <Label>
                  {isCreator
                    ? "Offerings (comma-separated, optional)"
                    : "Services (comma-separated, optional)"}
                </Label>
                <Input
                  value={form.services}
                  onChange={set("services")}
                  placeholder={
                    isCreator ? "Sponsorships, UGC, Coaching, Merch" : "Catering, Barista training"
                  }
                />
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div>
                <Label>{isCreator ? "Your voice (optional but powerful)" : "Brand voice (optional but powerful)"}</Label>
                <Textarea
                  rows={3}
                  value={form.brandVoice}
                  onChange={set("brandVoice")}
                  placeholder={
                    isCreator
                      ? "Casual and funny, first person, lots of storytelling — never salesy."
                      : "Warm, knowledgeable, a little playful — never corporate."
                  }
                />
              </div>
              <div>
                <Label>
                  {isCreator
                    ? "Creators you admire / compete with (comma-separated, optional)"
                    : "Competitors (comma-separated, optional)"}
                </Label>
                <Input
                  value={form.competitors}
                  onChange={set("competitors")}
                  placeholder={isCreator ? "@creator1, @creator2" : "Brand A, Brand B"}
                />
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
