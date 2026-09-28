import React from "react";
import * as rtl from "@testing-library/react";
import ChatPopoverMessage from "../../../../component/investigation/ChatPopover/ChatPopoverMessage";

describe("ChatPopoverMessage Component", () => {
  test("renders message text", () => {
    rtl.render(<ChatPopoverMessage message="Hello World" />);
    expect(rtl.screen.getByText("Hello World")).toBeInTheDocument();
  });

  test("renders with user role class", () => {
    const { container } = rtl.render(<ChatPopoverMessage message="User message" roleUser={true} />);
    expect(container.firstChild).toHaveClass("chat-popover-dialog-body-message-user");
  });

  test("renders without user role class when roleUser is false or undefined", () => {
    const { container } = rtl.render(<ChatPopoverMessage message="Assistant message" />);
    expect(container.firstChild).not.toHaveClass("chat-popover-dialog-body-message-user");
  });

  test("renders avatar image with provided avatar prop", () => {
    rtl.render(<ChatPopoverMessage message="With avatar" avatar="avatar.png" />);
    const img = rtl.screen.getByAltText("assistant") as HTMLImageElement;
    expect(img.src).toContain("avatar.png");
  });

  test("renders default avatar image when avatar prop is not provided", () => {
    rtl.render(<ChatPopoverMessage message="Default avatar" />);
    const img = rtl.screen.getByAltText("assistant") as HTMLImageElement;
    expect(img.src).toContain("/assets/img/aksha.jpg");
  });
});
