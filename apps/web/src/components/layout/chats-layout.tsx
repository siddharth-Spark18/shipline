import { Outlet } from 'react-router-dom';
import ChatListPanel from '@/pages/ticket-workspace/components/chat-list/chat-list-panel';

/** The Chats module: the chat list next to the new-chat screen or the open chat. */
export default function ChatsLayout() {
  return (
    <div className="absolute inset-0 flex">
      <ChatListPanel />
      <div className="relative min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
