import { useQuery } from '@tanstack/react-query';
import { systemApi } from '@/services/systemApi';

export const systemKeys = {
  health: ['system', 'health'] as const,
  ready: ['system', 'ready'] as const,
  config: ['system', 'config'] as const,
};

export function useHealth() {
  return useQuery({ queryKey: systemKeys.health, queryFn: systemApi.health, refetchInterval: 60_000 });
}

export function useReadiness() {
  return useQuery({ queryKey: systemKeys.ready, queryFn: systemApi.ready });
}

export function usePublicConfig() {
  return useQuery({ queryKey: systemKeys.config, queryFn: systemApi.config, staleTime: 5 * 60_000 });
}
