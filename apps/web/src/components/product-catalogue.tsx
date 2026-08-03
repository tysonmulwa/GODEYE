"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Download, Package, X } from "lucide-react";
import { useState } from "react";
import { AVAILABLE_PLATFORMS, PLATFORM_INFO, type Platform } from "@godeye/shared";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { Badge, Button, Card, ErrorNote, Label, Switch, cx } from "@/components/ui";

interface ProductSettings {
  website: string | null;
  importConsentAt: string | null;
  lastImportAt: string | null;
  autoImport: boolean;
  autoPost: boolean;
  postPlatforms: Platform[];
  productCount: number;
}

interface Product {
  id: string;
  title: string;
  price: string | null;
  currency: string | null;
  imageUrl: string | null;
  availability: string | null;
  sourceUrl: string;
  source: string;
  postCount: number;
}

export function ProductCatalogueCard() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProductSettings | null>(null);

  const { data: saved } = useQuery<ProductSettings>({
    queryKey: ["product-settings"],
    queryFn: () => api("/products/settings"),
  });
  const settings = draft ?? saved;
  const allowed = !!settings?.importConsentAt;

  const { data: products = [] } = useQuery<Product[]>({
    queryKey: ["products"],
    queryFn: () => api("/products?limit=12"),
    enabled: allowed,
  });

  const save = useMutation({
    mutationFn: (next: ProductSettings) =>
      api("/products/settings", {
        method: "PUT",
        body: {
          importConsent: !!next.importConsentAt,
          autoImport: next.autoImport,
          autoPost: next.autoPost,
          postPlatforms: next.postPlatforms,
        },
      }),
    onSuccess: () => {
      setError(null);
      setDraft(null);
      queryClient.invalidateQueries({ queryKey: ["product-settings"] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Failed to save"),
  });

  const runImport = useMutation({
    mutationFn: () => api("/products/import", { method: "POST", body: { limit: 40 } }),
    onSuccess: () => {
      // The crawl runs in the engine, so there is nothing to show yet. Say
      // that rather than leaving the button looking like it did nothing.
      toast.success("Reading your website. Products appear here as they are found.");
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["products"] });
        queryClient.invalidateQueries({ queryKey: ["product-settings"] });
      }, 8000);
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Import failed"),
  });

  const removeProduct = useMutation({
    mutationFn: (id: string) => api(`/products/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["product-settings"] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Could not remove it"),
  });

  const clearAll = useMutation({
    mutationFn: () => api<{ deleted: number }>("/products", { method: "DELETE" }),
    onSuccess: (result) => {
      toast.success(`Removed ${result.deleted} product${result.deleted === 1 ? "" : "s"}.`);
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["product-settings"] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Could not clear the catalogue"),
  });

  if (!settings) return null;

  const update = (patch: Partial<ProductSettings>) => {
    const next = { ...settings, ...patch };
    setDraft(next);
    save.mutate(next);
  };

  const togglePlatform = (platform: Platform) => {
    const chosen = settings.postPlatforms.includes(platform)
      ? settings.postPlatforms.filter((p) => p !== platform)
      : [...settings.postPlatforms, platform];
    // Turning off the last destination turns off auto-post: posting to
    // nowhere looks exactly like a feature that quietly does not work.
    update({ postPlatforms: chosen, autoPost: chosen.length ? settings.autoPost : false });
  };

  return (
    <Card>
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Product catalogue</h2>
        {settings.productCount > 0 && (
          <Badge
            status={`${settings.productCount} product${settings.productCount === 1 ? "" : "s"}`}
          />
        )}
      </div>
      <p className="mb-4 text-xs text-ink-3">
        GODEYE can read the products on your own website — names, prices, descriptions
        and photos — and write posts from them.
      </p>

      {!settings.website && (
        <div className="mb-4 rounded-lg border border-line bg-surface-2 p-3 text-xs text-ink-2">
          Add your website to the business profile first. That is the site this reads.
        </div>
      )}

      <Switch
        checked={allowed}
        onChange={(value) =>
          update({
            importConsentAt: value ? new Date().toISOString() : null,
            // Withdrawing permission stops the scheduled work too, rather
            // than leaving jobs pointing at a site we may no longer read.
            autoImport: value ? settings.autoImport : false,
            autoPost: value ? settings.autoPost : false,
          })
        }
        label="Allow GODEYE to read my website"
        hint={
          settings.website
            ? `Reads ${settings.website} as a search engine would, identifying itself as GODEYE. You can withdraw this at any time.`
            : "Set a website on your business profile first."
        }
      />

      {allowed && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button
              variant="secondary"
              className="h-9"
              loading={runImport.isPending}
              disabled={!settings.website}
              onClick={() => runImport.mutate()}
            >
              <Download className="h-4 w-4" />
              Import products now
            </Button>
            {settings.lastImportAt && (
              <span className="font-mono text-[12px] text-ink-3">
                last read {new Date(settings.lastImportAt).toLocaleString()}
              </span>
            )}
          </div>

          <div className="mt-4 space-y-3">
            <Switch
              checked={settings.autoImport}
              onChange={(value) => update({ autoImport: value })}
              label="Keep it up to date"
              hint="Re-reads your website a few times a day, so a new product does not wait for you to press import."
            />
            <Switch
              checked={settings.autoPost}
              onChange={(value) => update({ autoPost: value })}
              label="Post products automatically"
              hint="Writes and schedules a post about one product at a time, newest first, and rotates through the rest. Each is scheduled half an hour ahead so you can cancel it from the calendar."
            />
          </div>

          {settings.autoPost && (
            <div className="mt-3">
              <Label>Where product posts go</Label>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {AVAILABLE_PLATFORMS.map((platform) => (
                  <button
                    key={platform}
                    type="button"
                    onClick={() => togglePlatform(platform)}
                    className={cx(
                      "rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                      settings.postPlatforms.includes(platform)
                        ? "border-accent bg-accent-soft text-ink"
                        : "border-line text-ink-2 hover:border-ink-3",
                    )}
                  >
                    {PLATFORM_INFO[platform]?.label ?? platform}
                  </button>
                ))}
              </div>
              {settings.postPlatforms.length === 0 && (
                <p className="mt-2 text-xs text-amber-600">
                  Choose at least one destination, or nothing will be posted.
                </p>
              )}
            </div>
          )}

          {/* Not a disclaimer. These rules decide what the generator is even
              able to write, and a shop owner reading this should know why
              their posts never mention a sale. */}
          <div className="mt-4 flex gap-2.5 rounded-lg border border-line bg-surface-2 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" />
            <div className="text-xs leading-relaxed text-ink-3">
              <p className="font-medium text-ink-2">
                Product posts never claim a discount or that stock is running out.
              </p>
              <p className="mt-1">
                EU and UK law lets a shop announce a price reduction only alongside the
                lowest price of the previous 30 days, and bans claiming limited stock or
                time that is not real. An imported catalogue has today&rsquo;s price and no
                history, so those claims are blocked rather than written and hoped for.
              </p>
            </div>
          </div>

          {products.length > 0 && (
            <div className="mt-4 border-t border-line pt-4">
              <div className="flex items-center justify-between">
                <Label>Newest first</Label>
                <button
                  type="button"
                  onClick={() => {
                    // Deleting a catalogue is not undoable, and the next
                    // import brings it all back, so the difference matters.
                    if (
                      window.confirm(
                        `Remove all ${settings.productCount} products? Importing again will read them back from your website.`,
                      )
                    ) {
                      clearAll.mutate();
                    }
                  }}
                  className="text-[12px] text-ink-3 underline hover:text-ink"
                >
                  Remove all
                </button>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {products.map((product) => (
                  <a
                    key={product.id}
                    href={product.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="group relative rounded-lg border border-line p-2 transition-colors hover:border-ink-3"
                  >
                    {/* Always visible, not on hover: a phone has no hover, and
                        this was exactly the bug on the media remove button. */}
                    <button
                      type="button"
                      aria-label={`Remove ${product.title}`}
                      onClick={(e) => {
                        e.preventDefault();
                        removeProduct.mutate(product.id);
                      }}
                      // surface-2 is the card colour; surface-1 does not exist,
                      // so this chip was transparent and the control nearly
                      // invisible against a photograph.
                      className="absolute right-1 top-1 z-10 rounded-full bg-surface-2/90 p-1 text-ink-2 shadow-sm hover:text-red-500"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                    {product.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={product.imageUrl}
                        alt=""
                        className="mb-1.5 aspect-square w-full rounded object-cover"
                      />
                    ) : (
                      <div className="mb-1.5 flex aspect-square w-full items-center justify-center rounded bg-surface-3">
                        <Package className="h-5 w-5 text-ink-3" />
                      </div>
                    )}
                    <p className="truncate text-[12px] font-medium">{product.title}</p>
                    <p className="truncate font-mono text-[11px] text-ink-3">
                      {product.price ? `${product.currency ?? ""} ${product.price}` : "no price"}
                      {product.postCount > 0 && ` · posted ${product.postCount}x`}
                    </p>
                  </a>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <div className="mt-3">
        <ErrorNote message={error} />
      </div>
    </Card>
  );
}
