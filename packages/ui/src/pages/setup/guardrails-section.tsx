import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type { ConfigModel } from '@/lib/types';

const README_URL = 'https://github.com/siddharth-Spark18/shipline#7-guardrails';

type Level = 'deny' | 'ask' | 'off';
const LEVELS: { value: Level; label: string }[] = [
  { value: 'deny', label: 'Deny' },
  { value: 'ask', label: 'Ask' },
  { value: 'off', label: 'Off' },
];

/** The rails, their defaults for new installs, and what each one watches for. */
const RAILS: { id: string; name: string; description: string; fallback: Level }[] = [
  {
    id: 'force_push_default',
    name: 'Force-push to the default branch',
    description: 'git push --force (or +branch, --delete) on main, and git branch -D on it.',
    fallback: 'deny',
  },
  {
    id: 'push_default',
    name: 'Push to the default branch',
    description: 'Any git push whose target is the default branch.',
    fallback: 'ask',
  },
  {
    id: 'pipe_to_shell',
    name: 'Pipe a download into a shell',
    description: 'curl or wget piped into sh, bash, python, node and the like.',
    fallback: 'deny',
  },
  {
    id: 'print_credentials',
    name: 'Print credentials',
    description: 'cat, grep or printenv on .env, keys, ~/.ssh or ~/.aws, or echoing a token.',
    fallback: 'deny',
  },
  {
    id: 'read_credentials',
    name: 'Read credential files',
    description: "The Read tool on those same files (needs Read in the hook's matcher).",
    fallback: 'ask',
  },
  {
    id: 'deploy',
    name: 'Deploy commands',
    description: 'kubectl apply, terraform apply, fly deploy, npm run deploy and the like.',
    fallback: 'ask',
  },
  {
    id: 'migrate',
    name: 'Database migrations',
    description: 'prisma migrate deploy, rails db:migrate, alembic upgrade and the like.',
    fallback: 'ask',
  },
  {
    id: 'agent_config',
    name: 'Agent configuration',
    description: 'Edits to .claude/**, .shipline/**, CLAUDE.md and .mcp.json.',
    fallback: 'ask',
  },
];

const isLevel = (v: unknown): v is Level => v === 'deny' || v === 'ask' || v === 'off';

/** One value per line. Uncontrolled, so a trailing newline survives while typing. */
function LinesField({
  id,
  label,
  hint,
  value,
  placeholder,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string[];
  placeholder?: string;
  disabled?: boolean;
  onChange: (lines: string[]) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        className="min-h-20 font-mono text-xs"
        defaultValue={value.join('\n')}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value.split('\n').filter((l) => l.trim() !== ''))}
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * The Guardrails section: each rail's deny / ask / off, the protected paths, the extra deploy and migrate
 * commands, and the Verify scope check. All of it lives in config.yml and saves with the rest of the config.
 */
export function GuardrailsSection({
  model,
  readOnly,
  onChange,
}: {
  model: ConfigModel | null;
  readOnly: boolean;
  onChange: (model: ConfigModel) => void;
}) {
  if (!model) {
    return (
      <Alert variant="destructive">
        <AlertTitle>config.yml does not parse</AlertTitle>
        <AlertDescription>Fix it by hand, then reload, to edit the guardrails.</AlertDescription>
      </Alert>
    );
  }

  const setRail = (id: string, value: Level) =>
    onChange({ ...model, rails: { ...(model.rails ?? {}), [id]: value } });
  const setCommands = (key: 'deploy' | 'migrate', lines: string[]) =>
    onChange({ ...model, rails_commands: { ...(model.rails_commands ?? {}), [key]: lines } });
  const setScope = (patch: NonNullable<ConfigModel['scope_check']>) =>
    onChange({ ...model, scope_check: { ...(model.scope_check ?? {}), ...patch } });

  const scopeOn = model.scope_check?.enabled !== false;

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-sm font-medium">Guardrails</h2>
      <Alert>
        <AlertTitle>Defence in depth</AlertTitle>
        <AlertDescription>
          These run inside Claude Code&apos;s hooks: they stop mistakes, not a determined user. For
          hard limits use Claude Code&apos;s sandbox and managed settings.{' '}
          <a
            className="underline underline-offset-2"
            href={README_URL}
            target="_blank"
            rel="noreferrer"
          >
            Read more in the README
          </a>
          .
        </AlertDescription>
      </Alert>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Rails</h3>
        <p className="text-xs text-muted-foreground">
          Deny refuses the call. Ask shows Claude Code&apos;s own permission prompt. Off turns the
          rail off. They apply in every stage, with or without a task.
        </p>
        <ul className="divide-y rounded-md border">
          {RAILS.map((r) => {
            const raw = model.rails?.[r.id];
            const value: Level = isLevel(raw) ? raw : r.fallback;
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <Label htmlFor={`rail-${r.id}`}>{r.name}</Label>
                  <p className="text-xs text-muted-foreground">{r.description}</p>
                </div>
                <Select
                  value={value}
                  disabled={readOnly}
                  onValueChange={(v) => setRail(r.id, v as Level)}
                >
                  <SelectTrigger id={`rail-${r.id}`} className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LEVELS.map((l) => (
                      <SelectItem key={l.value} value={l.value}>
                        {l.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </li>
            );
          })}
        </ul>
      </div>

      <LinesField
        id="gr-protected"
        label="Protected paths (globs, one per line)"
        hint="Editing these asks first, in any stage. Relative to the repo root."
        value={model.protected_paths ?? []}
        placeholder="migrations/**"
        disabled={readOnly}
        onChange={(lines) => onChange({ ...model, protected_paths: lines })}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <LinesField
          id="gr-deploy"
          label="Extra deploy commands"
          hint="Plain prefixes, one per line, for example make ship."
          value={model.rails_commands?.deploy ?? []}
          disabled={readOnly}
          onChange={(lines) => setCommands('deploy', lines)}
        />
        <LinesField
          id="gr-migrate"
          label="Extra migration commands"
          hint="Plain prefixes, one per line."
          value={model.rails_commands?.migrate ?? []}
          disabled={readOnly}
          onChange={(lines) => setCommands('migrate', lines)}
        />
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">Verify scope check</h3>
        <div className="flex items-center gap-3">
          <Switch
            id="gr-scope"
            checked={scopeOn}
            disabled={readOnly}
            onCheckedChange={(on) => setScope({ enabled: on })}
          />
          <Label htmlFor="gr-scope">
            Ask before finishing Verify when the change edits tests, lint or CI config, or files
            outside the plan
          </Label>
        </div>
        <LinesField
          id="gr-scope-extra"
          label="More sensitive files (globs, one per line)"
          hint="Treated like test, lint and CI files."
          value={model.scope_check?.sensitive_extra ?? []}
          disabled={readOnly || !scopeOn}
          onChange={(lines) => setScope({ sensitive_extra: lines })}
        />
      </div>
    </div>
  );
}
