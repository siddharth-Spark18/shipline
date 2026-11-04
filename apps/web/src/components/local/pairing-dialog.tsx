import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { errorMessage } from '@/lib/api';
import { LocalApiError } from '@/lib/local-api';
import { usePairLocal } from '@/services/local/local.hooks';

const schema = z.object({ code: z.string().trim().min(4, 'Enter the code shown in the Shipline tray') });

/** One-time pairing: the code comes from the Shipline tray (or the `pnpm dev:local` terminal). */
export default function PairingDialog({ trigger }: { trigger?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const pair = usePairLocal();
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { code: '' } });

  const submit = form.handleSubmit(({ code }) =>
    pair.mutate(code, {
      onSuccess: () => {
        toast.success('Browser paired with Shipline Local');
        form.reset();
        setOpen(false);
      },
      onError: (err) =>
        form.setError('code', { message: err instanceof LocalApiError ? err.message : errorMessage(err) }),
    }),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger ?? <Button size="sm">Enter pairing code</Button>}</DialogTrigger>
      <DialogContent>
        <Form {...form}>
          <form onSubmit={submit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Pair this browser</DialogTitle>
              <DialogDescription>
                Shipline Local only accepts requests from a browser you paired once. Open the Shipline tray menu (or the terminal
                running <code>pnpm dev:local</code>) to read the one-time code.
              </DialogDescription>
            </DialogHeader>
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Pairing code</FormLabel>
                  <FormControl>
                    <Input autoFocus placeholder="ABCD-1234" autoComplete="off" {...field} />
                  </FormControl>
                  <FormDescription>The code changes after every successful pairing.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pair.isPending}>
                Pair
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
