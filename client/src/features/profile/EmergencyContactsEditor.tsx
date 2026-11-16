import { MAX_EMERGENCY_CONTACTS, normalizeIndianMobile } from '@mahilasathi/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Phone, Trash2, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button, ErrorState, Skeleton, TextField } from '@/components/ui';
import { usersApi } from '@/services/accountApi';

const contactsKey = ['me', 'emergency-contacts'] as const;

export function useEmergencyContacts() {
  return useQuery({ queryKey: contactsKey, queryFn: usersApi.contacts });
}

export function EmergencyContactsEditor() {
  const qc = useQueryClient();
  const contacts = useEmergencyContacts();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [relationship, setRelationship] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () => usersApi.addContact({ name, phone, relationship: relationship.trim() || null }),
    onSuccess: () => {
      setName('');
      setPhone('');
      setRelationship('');
      void qc.invalidateQueries({ queryKey: contactsKey });
    },
  });
  const remove = useMutation({
    mutationFn: usersApi.deleteContact,
    onSuccess: () => void qc.invalidateQueries({ queryKey: contactsKey }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setFormError('Enter a name');
    if (!normalizeIndianMobile(phone)) return setFormError('Enter a valid 10-digit Indian mobile number');
    setFormError(null);
    add.mutate();
  };

  if (contacts.isPending) return <Skeleton className="h-24 w-full" />;
  if (contacts.isError) return <ErrorState message={contacts.error.message} onRetry={() => void contacts.refetch()} />;

  const list = contacts.data.contacts;
  const full = list.length >= MAX_EMERGENCY_CONTACTS;

  return (
    <div className="space-y-4">
      {list.length > 0 ? (
        <ul className="divide-y divide-border/60 rounded-2xl border border-border/70 bg-surface">
          {list.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-4 py-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-soft text-fg">
                <Phone className="h-4 w-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{c.name}{c.relationship ? <span className="font-normal text-fg-muted"> · {c.relationship}</span> : null}</p>
                <p className="text-sm text-fg-muted">{c.phone.replace(/^\+91(\d{5})(\d{5})$/, '+91 $1 $2')}</p>
              </div>
              <button
                type="button"
                className="flex h-9 w-9 items-center justify-center rounded-xl text-fg-muted hover:bg-surface-muted hover:text-fg"
                aria-label={`Remove ${c.name}`}
                onClick={() => remove.mutate(c.id)}
                disabled={remove.isPending}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-fg-muted">No emergency contacts yet.</p>
      )}

      {full ? (
        <p className="text-sm text-fg-muted">You’ve added the maximum of {MAX_EMERGENCY_CONTACTS} contacts.</p>
      ) : (
        <form onSubmit={submit} className="space-y-3 rounded-2xl border border-dashed border-border p-3.5" noValidate>
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={60} />
          <TextField label="Mobile number" leading={<span className="text-sm">+91</span>} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="off" />
          <TextField label="Relationship (optional)" placeholder="e.g. Sister, Friend" value={relationship} onChange={(e) => setRelationship(e.target.value)} maxLength={40} />
          {formError || add.isError ? <p role="alert" className="text-sm text-danger">{formError ?? add.error?.message}</p> : null}
          <Button type="submit" variant="secondary" fullWidth icon={<UserPlus className="h-4 w-4" aria-hidden />} loading={add.isPending}>
            Add contact
          </Button>
        </form>
      )}
      {remove.isError ? <p role="alert" className="text-sm text-danger">{remove.error.message}</p> : null}
    </div>
  );
}
