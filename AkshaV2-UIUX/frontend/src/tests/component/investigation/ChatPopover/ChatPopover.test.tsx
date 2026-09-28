import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ChatPopover from "../../../../component/investigation/ChatPopover/ChatPopover";

jest.mock("../../../../utils/envHelper", () => ({
  getEnvVar: jest.fn((key: string) => {
    const envs: Record<string, string> = {
      VITE_IMAGE_ANALYSIS: "/api/image-analysis",
      VITE_DownloadImageAnalysisChat: "/api/download",
    };
    return envs[key] || "";
  }),
}));

import axios from "axios";
jest.mock("axios");

// Mock ChatPopoverMessage
jest.mock(
  "../../../../component/investigation/ChatPopover/ChatPopoverMessage",
  () => (props: any) => (
    <div data-testid="chat-message">
      {props.roleUser ? "User: " : "Assistant: "}
      {props.message}
    </div>
  )
);

window.HTMLElement.prototype.scrollTo = jest.fn();

// ------------------------------------------------------
// BEFORE ALL (fix dialog + missing URL functions)
// ------------------------------------------------------
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.show = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = jest.fn();

  // FIX missing browser functions in JSDOM
  if (!window.URL.createObjectURL) {
    window.URL.createObjectURL = jest.fn();
  }
  if (!window.URL.revokeObjectURL) {
    window.URL.revokeObjectURL = jest.fn();
  }
});

describe("ChatPopover Component", () => {
  let modalRef: any;

  beforeEach(() => {
    jest.clearAllMocks();
    modalRef = { current: { close: jest.fn() } };
  });

  test("renders main elements", () => {
    render(
      <ChatPopover
        modalRef={modalRef}
        imgUrl="test.jpg"
        base64Image="base64"
        setImgUrl={jest.fn()}
      />
    );

    document.querySelector("dialog")!.showModal();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /close/i })).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Type a question...")
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/select model/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /download your chat/i })
    ).toBeInTheDocument();
  });

  test("close button clears chat and closes modal", () => {
    const setImgUrlMock = jest.fn();

    render(
      <ChatPopover
        modalRef={modalRef}
        imgUrl="test.jpg"
        base64Image="base64"
        setImgUrl={setImgUrlMock}
      />
    );
    document.querySelector("dialog")!.showModal();

    fireEvent.click(screen.getByRole("button", { name: /close/i }));

    expect(setImgUrlMock).toHaveBeenCalledWith("");
    expect(modalRef.current.close).toHaveBeenCalled();
  });

  test("select dropdown changes model selection", () => {
    render(
      <ChatPopover
        modalRef={modalRef}
        imgUrl="test.jpg"
        base64Image="base64"
        setImgUrl={jest.fn()}
      />
    );
    document.querySelector("dialog")!.showModal();

    const select = screen.getByLabelText(/select model/i);

    expect(select).toHaveValue("1");

    fireEvent.change(select, { target: { value: "2" } });

    expect(select).toHaveValue("2");
  });

  test("form submission sends API request and updates chat history", async () => {
    const mockResponse = { data: JSON.stringify({ answer: "Test answer" }) };
    (axios.post as jest.Mock).mockResolvedValueOnce(mockResponse);

    render(
      <ChatPopover
        modalRef={modalRef}
        imgUrl="test.jpg"
        base64Image="base64"
        setImgUrl={jest.fn()}
      />
    );
    document.querySelector("dialog")!.showModal();

    const input = screen.getByPlaceholderText("Type a question...");
    const form = screen.getByRole("form");

    fireEvent.change(input, { target: { value: "Hello" } });
    fireEvent.submit(form);

    await waitFor(() => expect(axios.post).toHaveBeenCalled());

    expect(screen.getAllByTestId("chat-message").length).toBeGreaterThan(0);
  });

  test("download button triggers download API call", async () => {
    const mockBlob = new Blob(["test"], { type: "application/zip" });

    const mockResponse = {
      data: mockBlob,
      headers: {
        "content-disposition": 'attachment; filename="chat.zip"',
      },
    };

    (axios.post as jest.Mock).mockResolvedValueOnce(mockResponse);

    render(
      <ChatPopover
        modalRef={modalRef}
        imgUrl="test.jpg"
        base64Image="base64"
        setImgUrl={jest.fn()}
      />
    );
    document.querySelector("dialog")!.showModal();

    const downloadButton = screen.getByRole("button", {
      name: /download your chat/i,
    });

    const createObjectURLMock = jest
      .spyOn(window.URL, "createObjectURL")
      .mockReturnValue("blob:url");

    const revokeObjectURLMock = jest
      .spyOn(window.URL, "revokeObjectURL")
      .mockImplementation(() => {});

    fireEvent.click(downloadButton);

    await waitFor(() => expect(axios.post).toHaveBeenCalled());

    createObjectURLMock.mockRestore();
    revokeObjectURLMock.mockRestore();
  });
});
