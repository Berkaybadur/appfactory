-- Keep only deleted IDs so an offline device cannot recreate removed content.
create table public.factory_project_deletions (
  workspace_id uuid not null references public.factory_workspaces(id) on delete cascade,
  id text not null check (id ~ '^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$'),
  completed boolean not null default false,
  primary key (workspace_id, id)
);
alter table public.factory_project_deletions enable row level security;
revoke all on public.factory_project_deletions from public, anon, authenticated;
grant select on public.factory_project_deletions to authenticated;
create policy deletions_read on public.factory_project_deletions for select to authenticated
  using (exists (select 1 from public.factory_workspace_members m
    where m.workspace_id = factory_project_deletions.workspace_id and m.user_id = (select auth.uid())));

create function public.guard_deleted_factory_project() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.workspace_id::text || ':' || new.id, 0));
  if exists (select 1 from public.factory_project_deletions d where d.workspace_id = new.workspace_id and d.id = new.id) then
    raise exception 'PROJECT_DELETED' using errcode = '40001';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_deleted_factory_project() from public, anon, authenticated;
create trigger guard_deleted_project before insert or update on public.factory_projects
  for each row execute function public.guard_deleted_factory_project();

-- Prepare fences cloud writes; finish is called only after GitHub/local cleanup.
-- The project document stays visible after a failed external operation for retry.
create function public.delete_factory_project(target_workspace uuid, target_id text, confirmation text, finish boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare project_name text;
begin
  if auth.uid() is null or not exists (select 1 from public.factory_workspace_members m
    where m.workspace_id = target_workspace and m.user_id = auth.uid()) then
    raise exception 'Workspace access required' using errcode = '42501';
  end if;
  if target_id is null or target_id !~ '^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$' or confirmation is null or length(confirmation) = 0 then
    raise exception 'Invalid deletion request';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target_workspace::text || ':' || target_id, 0));
  select document->>'name' into project_name from public.factory_projects
    where workspace_id = target_workspace and id = target_id;
  if project_name is not null and project_name <> confirmation then
    raise exception 'Project name changed; reload before deleting';
  end if;
  if finish then
    if not exists (select 1 from public.factory_project_deletions where workspace_id = target_workspace and id = target_id) then
      raise exception 'Prepare deletion first';
    end if;
    -- The optional legacy factory_design_assets table has an ON DELETE CASCADE FK.
    delete from public.factory_projects where workspace_id = target_workspace and id = target_id;
    update public.factory_project_deletions set completed = true where workspace_id = target_workspace and id = target_id;
  else
    insert into public.factory_project_deletions(workspace_id, id) values (target_workspace, target_id)
      on conflict (workspace_id, id) do nothing;
  end if;
end;
$$;
revoke all on function public.delete_factory_project(uuid, text, text, boolean) from public, anon;
grant execute on function public.delete_factory_project(uuid, text, text, boolean) to authenticated;
