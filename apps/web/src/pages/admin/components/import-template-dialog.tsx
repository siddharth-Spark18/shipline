import { ChangeEvent, ReactNode, useState } from 'react';
import { Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { errorCode, errorMessage } from '@/lib/api';
import { useImportTemplate } from '@/services/admin/admin.hooks';

/**
 * Import a template file: a new template, or a new version of the same-named one. If the file names
 * custom agents this org lacks, the server says so and the dialog offers to create them from the
 * definitions bundled in the file.
 */
export default function ImportTemplateDialog({ trigger }: { trigger: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [offer, setOffer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const importer = useImportTemplate();

  const reset = () => {
    setText('');
    setOffer(null);
    setError(null);
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setText(await file.text());
    e.target.value = '';
  };

  const run = async (createMissingAgents: boolean) => {
    setError(null);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      setError('This is not valid JSON.');
      return;
    }
    try {
      const result = await importer.mutateAsync({ data, createMissingAgents });
      toast.success(
        result.outcome === 'created'
          ? `Imported "${result.template.name}"${result.createdAgents.length ? ` and created ${result.createdAgents.length} agent(s)` : ''}`
          : `Imported as version ${result.template.latestVersion} of "${result.template.name}"`,
      );
      setOpen(false);
      reset();
    } catch (err) {
      if (errorCode(err) === 'AGENTS_MISSING') setOffer(errorMessage(err));
      else setError(errorMessage(err));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Import a template</DialogTitle>
          <DialogDescription>
            Choose an exported file or paste its JSON. It is validated first. A template with the same name gets a new version; otherwise a new template is created.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input type="file" accept="application/json,.json" onChange={(e) => void onFile(e)} />
          <Textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder='{ "format": "shipline.workflow-template", ... }' className="font-mono text-xs" />
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {offer && (
            <Alert>
              <AlertDescription className="space-y-2">
                <p>{offer}</p>
                <Button size="sm" onClick={() => void run(true)} disabled={importer.isPending}>
                  Create agents and import
                </Button>
              </AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={() => void run(false)} disabled={!text.trim() || importer.isPending}>
            {importer.isPending ? <Loader2 className="animate-spin" /> : <Upload />} Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
