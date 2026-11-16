import {
  authResultSchema,
  emergencyContactSchema,
  meSchema,
  preferencesSchema,
  sendOtpResponseSchema,
  type CreateEmergencyContact,
  type Preferences,
  type UpdateMe,
} from '@mahilasathi/shared';
import { z } from 'zod';
import { apiRequest } from './apiClient';

export const authApi = {
  sendOtp: (phone: string) => apiRequest('/auth/send-otp', { method: 'POST', body: { phone }, schema: sendOtpResponseSchema }),
  verifyOtp: (otpSessionId: string, code: string) =>
    apiRequest('/auth/verify-otp', { method: 'POST', body: { otpSessionId, code }, schema: authResultSchema }),
  logout: () => apiRequest('/auth/logout', { method: 'POST' }),
  me: () => apiRequest('/auth/me', { schema: meSchema }),
};

export const usersApi = {
  updateMe: (patch: UpdateMe) => apiRequest('/users/me', { method: 'PATCH', body: patch, schema: meSchema }),
  deleteAccount: () => apiRequest('/users/me', { method: 'DELETE', body: { confirm: 'DELETE' } }),
  preferences: () => apiRequest('/users/me/preferences', { schema: preferencesSchema }),
  updatePreferences: (patch: Partial<Preferences>) =>
    apiRequest('/users/me/preferences', { method: 'PATCH', body: patch, schema: preferencesSchema }),
  contacts: () =>
    apiRequest('/users/me/emergency-contacts', { schema: z.object({ contacts: z.array(emergencyContactSchema) }) }),
  addContact: (c: CreateEmergencyContact) =>
    apiRequest('/users/me/emergency-contacts', { method: 'POST', body: c, schema: emergencyContactSchema }),
  deleteContact: (id: string) => apiRequest(`/users/me/emergency-contacts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
