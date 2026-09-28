import "./ChatPopoverMessage.scss";

type ChatPopoverMessageProps = {
  message: string;
  roleUser?: boolean;
  avatar?: string;
};

const ChatPopoverMessage = ({
  message,
  roleUser,
  avatar,
}: ChatPopoverMessageProps) => {
  return (
    <div
      className={`chat-popover-dialog-body-message ${
        roleUser ? "chat-popover-dialog-body-message-user" : ""
      }`}
    >
      {/* avatar */}
      <div className="chat-popover-dialog-body-message-avatar">
        <img
          src={avatar ? avatar : "/assets/img/aksha.jpg"}
          alt="assistant"
          className="assistant-avatar"
        />
      </div>
      {/* Message */}
      <div className="chat-popover-dialog-body-message-text">
        <p>{message}</p>
      </div>
    </div>
  );
};

export default ChatPopoverMessage;
