"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Box, LayoutDashboard, Plus, ArrowUpRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useProjects } from "@/components/project-provider";
import { cn } from "@/lib/utils";
import { CloudAccount } from "./cloud-account";
import { AccountMenu } from "./account-menu";
export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const { error, cloud } = useProjects();
  return (
    <div className="min-h-screen">
      <header className="border-b bg-white">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 md:px-8">
          <Link
            href="/"
            className="flex items-center gap-2.5 font-semibold tracking-tight"
          >
            <span className="rounded-md bg-primary p-1.5 text-white">
              <Box size={18} />
            </span>
            App Factory{" "}
            <Badge variant="outline" className="ml-1">
              V1
            </Badge>
          </Link>
          <AccountMenu />
        </div>
      </header>
      <div className="mx-auto max-w-7xl px-5 md:px-8">
        <nav
          className="flex h-14 items-center gap-6 border-b text-sm"
          aria-label="Ana menü"
        >
          <Link
            href="/"
            className={cn(
              "flex h-full items-center gap-2 border-b-2",
              path === "/"
                ? "border-foreground font-medium"
                : "border-transparent text-muted-foreground",
            )}
          >
            <LayoutDashboard size={15} />
            Panel
          </Link>
          <Link
            href="/projects/new"
            className={cn(
              "flex h-full items-center gap-2 border-b-2",
              path === "/projects/new"
                ? "border-foreground font-medium"
                : "border-transparent text-muted-foreground",
            )}
          >
            <Plus size={15} />
            Yeni Proje
          </Link>
          <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-amber-500" />
            {
              {
                local: "Yerel mod",
                loading: "Bulut yükleniyor…",
                "signed-out": "Yerel · Giriş yapılmadı",
                synced: "Supabase · Kaydedildi",
                refreshing: "Bulut güncellemeleri kontrol ediliyor…",
                saving: "Buluta kaydediliyor…",
                error: "Bulut eşitleme hatası",
              }[cloud.status]
            }
          </span>
        </nav>
        <CloudAccount />
        {error && (
          <p
            role="alert"
            className="mt-5 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm"
          >
            {error}
          </p>
        )}
        <main className="py-8 md:py-10">{children}</main>
        <footer className="mb-6 flex flex-wrap justify-between gap-2 border-t pt-5 text-xs text-muted-foreground">
          <span>App Factory · Adım adım mobil uygulama geliştirin.</span>
          <span>AI Planner · Yerel üretim</span>
        </footer>
      </div>
    </div>
  );
}
export function PageHeading({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}
export function Loading() {
  return (
    <p
      role="status"
      className="py-16 text-center text-sm text-muted-foreground"
    >
      Çalışma alanınız yükleniyor…
    </p>
  );
}
export function NewProjectLink() {
  return (
    <Button asChild>
      <Link href="/projects/new">
        <Plus />
        Yeni Proje
      </Link>
    </Button>
  );
}
export function BackToDashboard() {
  return (
    <Button variant="outline" asChild>
      <Link href="/">
        Panele Dön
        <ArrowUpRight />
      </Link>
    </Button>
  );
}
