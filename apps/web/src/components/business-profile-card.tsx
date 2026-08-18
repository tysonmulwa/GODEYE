"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { Button, Card, ErrorNote, Input, Label, Textarea } from "@/components/ui";

interface BusinessProfile {
  businessName: string;
  industry: string;
  description: string;
  targetAudience: string;
  location: string | null;
  website: string | null;
  goals: string[];
  brandVoice: string | null;
  // Not shown by this card, but sent back so saving does not wipe it, and
  // coerced from null, which the schema rejects.
  seasonalNotes: string | null;
}

/**
 * The business profile, after onboarding.
 *
 * It could only ever be written once, during onboarding, and several things
 * quietly depend on it afterwards: the website is what product import and SEO
 * audits read, and the location decides which currency prices are written in
 * and whether a post may state a former price. Getting either wrong at signup
 * meant living with it.
 *
 * Only the fields worth revisiting are here. The long-form description and
 * audience are edited too, because they are what the content agent writes
 * from, and a business that has changed direction should not keep posting as
 * the old one.
 */
export function BusinessProfileCard() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<BusinessProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: saved } = useQuery<BusinessProfile>({
    queryKey: ["business-profile"],
    queryFn: () => api("/business-profile"),
  });
  const profile = draft ?? saved;

  const save = useMutation({
    mutationFn: (body: BusinessProfile) =>
      api("/business-profile", {
        method: "PUT",
        // The row is sent back whole, so fields this card does not show are
        // preserved rather than wiped. Every optional string is coerced from
        // null to "": the database stores null for a blank one and the schema
        // accepts a string or "", so sending null fails validation on a
        // profile that simply left something empty.
        body: {
          ...body,
          location: body.location ?? "",
          website: body.website ?? "",
          brandVoice: body.brandVoice ?? "",
          seasonalNotes: body.seasonalNotes ?? "",
        },
      }),
    onSuccess: () => {
      setDraft(null);
      setError(null);
      // Product import and SEO both read the website from here.
      queryClient.invalidateQueries({ queryKey: ["business-profile"] });
      queryClient.invalidateQueries({ queryKey: ["product-settings"] });
      toast.success("Business profile saved.");
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Could not save"),
  });

  if (!profile) return null;
  const set = (patch: Partial<BusinessProfile>) => setDraft({ ...profile, ...patch });
  const dirty = draft !== null;

  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold">Business profile</h2>
      <p className="mb-4 text-xs text-ink-3">
        What the AI knows about the business. This is also where product import and
        SEO find your website.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label>Business name</Label>
          <Input
            value={profile.businessName}
            onChange={(e) => set({ businessName: e.target.value })}
          />
        </div>
        <div>
          <Label>Industry</Label>
          <Input value={profile.industry} onChange={(e) => set({ industry: e.target.value })} />
        </div>
      </div>

      <div className="mt-4">
        <Label>Website</Label>
        <Input
          type="url"
          inputMode="url"
          placeholder="https://yourshop.com"
          value={profile.website ?? ""}
          onChange={(e) => set({ website: e.target.value })}
        />
        <p className="mt-1 text-xs text-ink-3">
          The site product import reads and SEO audits crawl.
        </p>
      </div>

      <div className="mt-4">
        <Label>Location</Label>
        <Input
          placeholder="Nairobi, Kenya"
          value={profile.location ?? ""}
          onChange={(e) => set({ location: e.target.value })}
        />
        <p className="mt-1 text-xs text-ink-3">
          {/* Not cosmetic any more: this decides how prices are written and
              what a post is allowed to claim about them. */}
          Sets the currency prices are written in, and which consumer rules
          apply to what a post may say about pricing.
        </p>
      </div>

      <div className="mt-4">
        <Label>What the business does</Label>
        <Textarea
          rows={3}
          value={profile.description}
          onChange={(e) => set({ description: e.target.value })}
        />
      </div>

      <div className="mt-4">
        <Label>Who it is for</Label>
        <Textarea
          rows={2}
          value={profile.targetAudience}
          onChange={(e) => set({ targetAudience: e.target.value })}
        />
      </div>

      <div className="mt-4">
        <Label>Tone of voice</Label>
        <Input
          placeholder="Warm and direct, no jargon"
          value={profile.brandVoice ?? ""}
          onChange={(e) => set({ brandVoice: e.target.value })}
        />
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button
          disabled={!dirty}
          loading={save.isPending}
          onClick={() => save.mutate(profile)}
        >
          Save profile
        </Button>
        {dirty && <span className="text-xs text-ink-3">Unsaved changes</span>}
      </div>

      <div className="mt-3">
        <ErrorNote message={error} />
      </div>
    </Card>
  );
}
