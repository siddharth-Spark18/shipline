import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { OtherFields } from '@/pages/setup/other-fields';
import { setOptional } from '@/pages/setup/draft';
import type { ConfigModel, SetupFile } from '@/lib/types';

// `skills` is edited in the Agents & skills section and `ci` in the CI check section, so neither is listed
// as an "other field" here. `setup` is written by /shipline-setup and not editable.
const TOP_KEYS = ['branch_pattern', 'tracker', 'commands', 'skills', 'ci', 'setup'];
const TRACKERS = [
  { value: 'jira', label: 'Jira' },
  { value: 'github', label: 'GitHub Issues' },
];
const COMMAND_KEYS = ['test', 'lint', 'build'];

function patternError(v: string | null | undefined): string | null {
  if (!v) return null;
  if (!v.includes('{slug}')) return 'Must contain {slug}';
  for (const m of v.matchAll(/\{([^}]*)\}/g)) {
    if (!['key', 'slug', 'type'].includes(m[1]))
      return `{${m[1]}} is not allowed; use {key}, {slug} or {type}`;
  }
  return null;
}

function TextField({
  id,
  label,
  value,
  error,
  hint,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  error?: string | null;
  hint?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        className="font-mono"
        value={value}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        hint && <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

export function ConfigForm({
  file,
  model,
  onChange,
}: {
  file: SetupFile<ConfigModel>;
  model: ConfigModel | null;
  onChange: (model: ConfigModel) => void;
}) {
  if (file.parseError !== undefined || !model) {
    return (
      <div className="flex flex-col gap-3">
        <Alert variant="destructive">
          <AlertTitle>config.yml does not parse</AlertTitle>
          <AlertDescription>
            It is shown read-only. Fix it by hand, then reload.
            <br />
            {file.parseError}
          </AlertDescription>
        </Alert>
        <pre className="overflow-auto rounded-md border bg-muted p-3 font-mono text-xs">
          {file.raw}
        </pre>
      </div>
    );
  }

  const setTop = (key: string, value: string) => {
    const next = { ...model };
    setOptional(next, key, value);
    onChange(next);
  };
  // Command values may be empty strings: the shipped config.yml has `test: ""`.
  const setCommand = (key: string, value: string) =>
    onChange({ ...model, commands: { ...(model.commands ?? {}), [key]: value } });

  const tracker = model.tracker || 'jira';
  const supported = TRACKERS.some((t) => t.value === tracker);

  return (
    <div className="flex flex-col gap-4">
      <h2 className="font-mono text-sm">config.yml</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cfg-tracker">Tracker</Label>
          <Select value={tracker} onValueChange={(v) => setTop('tracker', v)}>
            <SelectTrigger id="cfg-tracker" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TRACKERS.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
              {!supported && <SelectItem value={tracker}>{tracker} (unsupported)</SelectItem>}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Where tickets live. Claude reads them; it never creates or edits issues.
          </p>
        </div>
        <TextField
          id="cfg-branch-pattern"
          label="Branch pattern"
          value={model.branch_pattern ?? ''}
          error={patternError(model.branch_pattern)}
          hint="{key}, {slug} and {type}; {slug} is required."
          onChange={(v) => setTop('branch_pattern', v)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Commands</h3>
        <p className="text-xs text-muted-foreground">
          The verify stage runs only the commands you set here.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          {COMMAND_KEYS.map((k) => (
            <TextField
              key={k}
              id={`cfg-cmd-${k}`}
              label={k}
              value={(model.commands?.[k] as string | undefined) ?? ''}
              onChange={(v) => setCommand(k, v)}
            />
          ))}
        </div>
        {model.commands && <OtherFields value={model.commands} known={COMMAND_KEYS} />}
      </div>

      <OtherFields value={model} known={TOP_KEYS} />
    </div>
  );
}
