import { AdminService } from '@/services/admin/admin.service';

/** Downloads a template as a JSON file (importable on the Workflow templates tab). */
export async function downloadTemplate(id: string, name: string): Promise<void> {
  const data = await AdminService.exportTemplate(id);
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'template'}.shipline-template.json`;
  a.click();
  URL.revokeObjectURL(url);
}
