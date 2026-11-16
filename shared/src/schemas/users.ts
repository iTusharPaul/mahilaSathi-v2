import { z } from 'zod';
import { indianMobileSchema } from './auth.js';

export const LOCATION_SHARING_OPTIONS = ['off', 'guardians_approximate', 'guardians_precise'] as const;
export const MAX_EMERGENCY_CONTACTS = 5;

const areaRef = z.object({ id: z.string(), name: z.string() });

/** The signed-in user's own profile. Phone appears masked; it is never shown to other users. */
export const meSchema = z.object({
  id: z.string(),
  maskedPhone: z.string(),
  displayName: z.string().nullable(),
  communityHandle: z.string(),
  homeArea: z
    .object({
      state: areaRef,
      district: areaRef,
      city: areaRef.nullable(),
      neighbourhood: areaRef.nullable(),
    })
    .nullable(),
  onboardingCompleted: z.boolean(),
  /** A fictional demo account (demo mode only). Its actions are labelled as demo everywhere. */
  isDemo: z.boolean(),
  createdAt: z.string(),
});
export type Me = z.infer<typeof meSchema>;

export const authResultSchema = z.object({ user: meSchema, isNewUser: z.boolean() });
export type AuthResult = z.infer<typeof authResultSchema>;

export const displayNameSchema = z
  .string()
  .trim()
  .min(2, 'Use at least 2 characters')
  .max(40, 'Use at most 40 characters')
  .regex(/^[\p{L}\p{M}\p{N} .'_-]+$/u, 'Use letters, numbers, spaces and . \' _ - only');

export const updateMeSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    /** Set home area by neighbourhood (preferred) or by district when no neighbourhood is mapped. */
    homeNeighbourhoodId: z.string().max(80).nullable().optional(),
    homeDistrictId: z.string().max(80).nullable().optional(),
    onboardingCompleted: z.literal(true).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateMe = z.infer<typeof updateMeSchema>;

export const preferencesSchema = z.object({
  locationSharingDefault: z.enum(LOCATION_SHARING_OPTIONS),
  notifyJourneyUpdates: z.boolean(),
  notifyCommunity: z.boolean(),
  notifySos: z.boolean(),
});
export type Preferences = z.infer<typeof preferencesSchema>;
export const updatePreferencesSchema = preferencesSchema
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

const contactName = z.string().trim().min(1, 'Enter a name').max(60);
const relationship = z.string().trim().max(40).nullable().optional();

export const emergencyContactSchema = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string(),
  relationship: z.string().nullable(),
  priority: z.number().int(),
});
export type EmergencyContact = z.infer<typeof emergencyContactSchema>;

export const createEmergencyContactSchema = z
  .object({ name: contactName, phone: indianMobileSchema, relationship })
  .strict();
export type CreateEmergencyContact = z.input<typeof createEmergencyContactSchema>;

export const updateEmergencyContactSchema = z
  .object({ name: contactName.optional(), phone: indianMobileSchema.optional(), relationship, priority: z.number().int().min(0).max(100).optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const deleteAccountSchema = z.object({ confirm: z.literal('DELETE') }).strict();
