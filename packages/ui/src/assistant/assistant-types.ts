import type { ReactNode, RefObject } from "react";

export type AssistantView = string;

export type AssistantNavigationItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  hidden?: boolean;
};

export type AssistantRecentConversation = {
  id: string;
  title: string;
  updatedAt: string;
};

export type AssistantIdentity = {
  name: string;
  subtitle?: string;
  icon?: ReactNode;
};

export type AssistantNavigationConfig = {
  title: string;
  items: AssistantNavigationItem[];
  recents: AssistantRecentConversation[] | null;
  selectedConversationId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onOpenConversation: (id: string) => void;
};

export type AssistantPanelProps = {
  open: boolean;
  onClose: () => void;
  hidden?: boolean;
  identity: AssistantIdentity;
  view: AssistantView;
  navigation: AssistantNavigationConfig;
  widthKey: string;
  defaultWidth?: number;
  navigationStorageKey?: string;
  ariaLabel?: string;
  closeLabel?: string;
  backdropClassName?: string;
  closeOnOutsideClick?: boolean;
  headerActions?: ReactNode;
  className?: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
};

export type AssistantLauncherProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  icon: ReactNode;
  storageKey: string;
  hidden?: boolean;
  bottomInset?: number;
  className?: string;
  dataAttributes?: Record<string, string>;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
};

export type AssistantSource = {
  id: string;
  title: string;
  href?: string;
};

export type AssistantMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt?: string;
  sources?: AssistantSource[];
};

export type AssistantChatTurn = {
  id: string;
  label?: string;
  user: AssistantMessage[];
  assistant: AssistantMessage[];
  details?: ReactNode;
};

export type AssistantChatProps = {
  className?: string;
  messagesClassName?: string;
  scrollKey: string;
  loading?: boolean;
  loadingContent?: ReactNode;
  leading?: ReactNode;
  historyAction?: ReactNode;
  empty?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyIcon?: ReactNode;
  turns: AssistantChatTurn[];
  extra?: ReactNode;
  renderAssistant: (message: AssistantMessage) => ReactNode;
  status?: ReactNode;
  error?: ReactNode;
  composer?: ReactNode;
};

export type AssistantConversation = {
  id: string;
  title: string;
  updatedAt: string;
  messageCount?: number;
};

export type AssistantConversationPage = {
  conversations: AssistantConversation[];
  nextCursor: string | null;
};

export type AssistantStreamEvent =
  | { type: "accepted"; messageId?: string }
  | { type: "delta"; text: string }
  | { type: "status"; state: string }
  | { type: "sources"; sources: AssistantSource[] }
  | { type: "completed"; message: AssistantMessage }
  | { type: "failed"; code?: string; message: string }
  | { type: "uncertain"; code?: string; message: string };

export type AssistantChatAdapter = {
  send(input: { conversationId?: string; text: string; requestKey: string }): Promise<{ taskId: string; conversationId?: string }>;
  stream(input: { taskId: string }): AsyncIterable<AssistantStreamEvent>;
  cancel?(taskId: string): Promise<void>;
};

export type AssistantConversationAdapter = {
  list(input?: { cursor?: string | null; query?: string }): Promise<AssistantConversationPage>;
  load(id: string): Promise<{ conversation: AssistantConversation; messages: AssistantMessage[] }>;
};

export type AssistantCapabilities = {
  canConfigure: boolean;
  canManageChannels: boolean;
};

export type AssistantAdapter = {
  identity: AssistantIdentity & { ready: boolean; state?: string };
  chat: AssistantChatAdapter;
  conversations: AssistantConversationAdapter;
  capabilities: AssistantCapabilities;
  editorPath?: string;
  channels?: ReactNode;
};
