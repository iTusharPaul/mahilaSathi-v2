import { MapPinOff } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EmptyState } from '@/components/ui';

export function NotFoundPage() {
  return (
    <EmptyState
      icon={<MapPinOff className="h-6 w-6" aria-hidden />}
      title="Page not found"
      description="The page you were looking for doesn't exist or has moved."
      action={
        <Link to="/" className="text-sm font-medium text-primary underline underline-offset-4">
          Go to home
        </Link>
      }
    />
  );
}
