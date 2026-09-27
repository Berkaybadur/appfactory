"use client";
import Link from "next/link";
import { DeleteProjectButton } from "@/components/delete-project-button";
import {
  ArrowUpRight,
  Smartphone,
  Folder,
  CircleDollarSign,
  Workflow,
} from "lucide-react";
import { useProjects } from "@/components/project-provider";
import { PageHeading, Loading, NewProjectLink } from "@/components/shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { progress, stageLabels } from "@app-factory/shared";
export default function Dashboard() {
  const { projects, ready } = useProjects();
  if (!ready) return <Loading />;
  const sorted = [...projects].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  const stats = [
    { label: "Toplam proje", value: projects.length, icon: Folder },
    {
      label: "Devam eden",
      value: projects.filter((p) => p.stage !== "idea").length,
      icon: Workflow,
    },
    {
      label: "Yapay zekâ harcaması",
      value: `$${projects.reduce((sum, p) => sum + p.aiCost, 0).toFixed(2)}`,
      icon: CircleDollarSign,
    },
  ];
  return (
    <>
      <PageHeading
        title="Panel"
        description="Fikirleriniz, planlarınız ve mobil uygulamalarınız tek bir yerde."
        action={<NewProjectLink />}
      />
      <div className="mb-10 grid gap-4 sm:grid-cols-3">
        {stats.map(({ label, value, icon: Icon }) => (
          <Card key={label} className="shadow-none">
            <CardContent className="pt-6">
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                {label}
                <Icon size={17} />
              </div>
              <div className="mt-3 text-3xl font-semibold tracking-tight">
                {value}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold">
          Projeler{" "}
          <span className="ml-2 font-normal text-muted-foreground">
            {projects.length}
          </span>
        </h2>
        <span className="text-xs text-muted-foreground">
          Son güncellenenler
        </span>
      </div>
      {sorted.length === 0 ? (
        <Card className="p-10 text-center">
          <h3 className="font-medium">Bir fikirle başlayın</h3>
          <p className="mb-5 text-sm text-muted-foreground">
            İlk mobil uygulama projenizi oluşturun.
          </p>
          <div>
            <NewProjectLink />
          </div>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {sorted.map((project) => (
            <Card
              key={project.id}
              className="h-full shadow-none hover:border-neutral-400"
            >
              <Link
                href={`/projects/${project.id}`}
                className="block rounded-xl outline-offset-4"
              >
                <CardContent className="pt-6">
                  <div className="mb-5 flex justify-between">
                    <span className="rounded-lg border bg-muted/50 p-2.5">
                      <Smartphone size={20} />
                    </span>
                    <ArrowUpRight size={17} className="text-muted-foreground" />
                  </div>
                  <h3 className="font-semibold">{project.name}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Mobil Uygulama ·{" "}
                    {[project.android && "Android", project.ios && "iOS"]
                      .filter(Boolean)
                      .join(" + ")}
                  </p>
                  <p className="my-5 line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground">
                    {project.idea}
                  </p>
                  <div className="mb-3 flex items-center justify-between">
                    <Badge variant="secondary">
                      {stageLabels[project.stage]}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {progress(project.stage)}%
                    </span>
                  </div>
                  <Progress
                    value={progress(project.stage)}
                    aria-label="Akış ilerlemesi"
                    className="h-1.5"
                  />
                  <div className="mt-5 flex items-center justify-between border-t pt-4 text-xs text-muted-foreground">
                    <span>
                      Yapay zekâ maliyeti{" "}
                      <span className="ml-1 text-foreground">
                        ${project.aiCost.toFixed(2)}
                      </span>
                    </span>
                    <time dateTime={project.updatedAt}>
                      Güncelleme:{" "}
                      {new Date(project.updatedAt).toLocaleDateString("tr-TR", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </time>
                  </div>
                </CardContent>
              </Link>
              <DeleteProjectButton project={project} />
            </Card>
          ))}
        </div>
      )}
      <div className="mt-8 rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">
          Fikirden mobil uygulamaya.
        </span>{" "}
        Plan → Ekranlar → Tasarım → Geliştirme → Testler → Derleme. Planlama AI
        Planner veya yerel örnek içeriklerle ilerler; Expo üretimi ve kod
        kontrolleri yerelde çalışır.
      </div>
    </>
  );
}
