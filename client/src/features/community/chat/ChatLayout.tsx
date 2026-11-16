import { Outlet } from 'react-router-dom';
import { ChatProvider } from './ChatContext';

/** Community screens share one chat connection, opened only while the user is in them. */
export function ChatLayout() {
  return (
    <ChatProvider>
      <Outlet />
    </ChatProvider>
  );
}
