import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/** Plain-text editor for `.shipline/rules/<stage id>.md`. */
export function RulesEditor({
  stageId,
  exists,
  value,
  onChange,
}: {
  stageId: string;
  exists: boolean;
  value: string;
  onChange: (text: string) => void;
}) {
  const inputId = `rules-${stageId}`;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={inputId}>
        Rules <span className="font-mono text-xs text-muted-foreground">rules/{stageId}.md</span>
      </Label>
      <Textarea
        id={inputId}
        className="min-h-32 font-mono text-xs"
        value={value}
        placeholder={
          exists ? undefined : 'No rules file yet. A file is created only if you type rules here.'
        }
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
