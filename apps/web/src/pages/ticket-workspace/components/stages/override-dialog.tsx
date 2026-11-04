import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/api';
import { useOverrideTicket } from '@/services/tickets/tickets.hooks';

const schema = z.object({
  kind: z.enum(['GATES', 'HOTFIX']),
  reason: z.string().trim().min(1, 'A reason is required'),
});

/** Admin override: skips the gates with a required reason; logged and shown on the PR check. */
export default function OverrideDialog({ ticketId }: { ticketId: string }) {
  const [open, setOpen] = useState(false);
  const override = useOverrideTicket(ticketId);
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { kind: 'GATES', reason: '' } });

  const submit = form.handleSubmit((values) =>
    override.mutate(values, {
      onSuccess: () => {
        toast.success('Override recorded');
        form.reset();
        setOpen(false);
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="xs" variant="destructive">
          Override gates
        </Button>
      </DialogTrigger>
      <DialogContent>
        <Form {...form}>
          <form onSubmit={submit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Admin override</DialogTitle>
              <DialogDescription>The override is logged and visible on the PR check.</DialogDescription>
            </DialogHeader>
            <FormField
              control={form.control}
              name="kind"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Type</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="GATES">Bypass gates</SelectItem>
                      <SelectItem value="HOTFIX">Hotfix</SelectItem>
                    </SelectContent>
                  </Select>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reason (required)</FormLabel>
                  <FormControl>
                    <Textarea rows={3} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={override.isPending}>
                Override
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
