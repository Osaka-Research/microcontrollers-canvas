create table if not exists public.component_catalog (
  id text primary key check (id <> 'board' and id ~ '^[A-Za-z][A-Za-z0-9_-]{0,59}$'),
  category text not null,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  version integer not null default 1 check (version > 0),
  definition jsonb not null check (jsonb_typeof(definition) = 'object' and definition ? 'id' and (definition->>'id') is not null and definition->>'id' = id),
  updated_at timestamptz not null default now()
);

create index if not exists component_catalog_published_category_idx
  on public.component_catalog (category, id) where status = 'published';

alter table public.component_catalog enable row level security;
revoke all on public.component_catalog from anon, authenticated;
grant select, insert, update on public.component_catalog to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('component-images', 'component-images', true, 5242880, array['image/png','image/jpeg','image/webp','image/svg+xml'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.user_projects (
  id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  project jsonb not null check (jsonb_typeof(project) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists user_projects_recent_idx on public.user_projects (user_id, updated_at desc);

create table if not exists public.project_templates (
  id uuid primary key,
  owner_id uuid references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  description text not null default '' check (char_length(description) <= 500),
  visibility text not null default 'private' check (visibility in ('private', 'public')),
  project jsonb not null check (jsonb_typeof(project) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_templates_public_idx on public.project_templates (updated_at desc) where visibility = 'public';
create index if not exists project_templates_owner_idx on public.project_templates (owner_id, updated_at desc);

alter table public.user_projects enable row level security;
alter table public.project_templates enable row level security;
revoke all on public.user_projects, public.project_templates from anon, authenticated;
grant select, insert, update, delete on public.user_projects, public.project_templates to service_role;
