
import { useEffect, useRef, useState } from "react";

import {
  MingcuteCloseFill,
  IconamoonSendThin,
} from "../../../assets/svg/iconify";
import ChatPopoverMessage from "./ChatPopoverMessage";

import UserAvatar from "../../../assets/images/profileImg.png";

import "./ChatPopover.scss";
import axios from "axios";
import getFilenameFromHeaders from "../../../utils/getFilenameFromHeaders";

type ChatHistory = {
  content: string;
  role: "assistant" | "user";
};

const ChatPopover = ({ modalRef, imgUrl, base64Image, setImgUrl }: any) => {
  const chatBodyRef = useRef<HTMLDivElement>(null);

  const [chatHistory, setChatHistory] = useState<ChatHistory[]>([]);
  const [selectedValue, setSelectedValue] = useState<string>("GPT 4o");
  const [selectedValueInt, setSelectedValueInt] = useState<string>("1");
  //const imageToBase64 = require('image-to-base64');

  const closeChatPopover = () => {
    setImgUrl("");
    setChatHistory([]);
    modalRef.current?.close();
  };

  const handleChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    // console.log("event.target.value = ", event.target.value);
    if (event.target.value === "1") {
      setSelectedValue("GPT 4o");
      setSelectedValueInt("1");
    } else {
      setSelectedValue("GPT 4 Turbo");
      setSelectedValueInt("2");
    }
  };

  const chatFormSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      const input = e.currentTarget.querySelector("input");
      if (input) {
        // console.log("input = ", input);
        const message = input.value;
        //await convertImageUrlToBase64(imgUrl);
        console.log(
          "input from user = ",
          input.value,
          " ",
          imgUrl,
          " ",
          base64Image
        );
        console.log("chatHistory = ", chatHistory);
        console.log("ChangeEvent ", selectedValue);

        // Append user input
        setChatHistory((prev) => [
          ...prev,
          {
            content: message,
            role: "user",
          },
          {
            content: "Please wait while I process your request...",
            role: "assistant",
          },
        ]);
        input.value = "";

        const headers = {
          "Content-Type": "application/json",
        };

        const params = JSON.stringify({
          question: message,
          image: base64Image,
          model_option: selectedValue,
          chat_history: chatHistory,
        });

        // console.log(
        //   "Sending req to " + import.meta.env.VITE_AZURE_IMAGEANALYSIS_URL
        // );
        const res = await axios.post(
          `${import.meta.env.VITE_ImageAnalysis}`,
          params,
          {
            headers: headers,
          }
        );
        console.log('res = ',res);
        console.log(res.data);
        const parsedData = JSON.parse(res.data);
        console.log(parsedData['answer'])
        // setllmresponse(res.data.answer);
        setChatHistory((prev) => [
          ...prev.slice(0, prev.length - 1),
          {
            content: parsedData['answer'],
            role: "assistant",
          },
        ]);
      }
    } catch (error) {
      console.error("Error in chatFormSubmit = ", error);
    }
  };

  // Send api request for Download chat with chat history and image
  const downloadChat = async () => {
    try {
      console.log("downloadChat");
      const headers = {
        "Content-Type": "application/json",
      };
      const body = JSON.stringify({
        image: base64Image,
        model_option: selectedValue,
        chat_history: chatHistory,
      });
      // Return zip file
      const response = await axios.post(
        `${import.meta.env.VITE_DownloadImageAnalysisChat}`,
        body,
        {
          responseType: "arraybuffer", // Important: This tells Axios to treat the response as binary data
          headers: headers,
        }
      );
      // Create a Blob from the response data
      const blob = new Blob([response.data], { type: "application/zip" });
      const filename = getFilenameFromHeaders(response.headers);

      // Create a link element and trigger the download
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;

      // Pass filename 
      link.setAttribute("download", filename); // or any other filename you want
      document.body.appendChild(link);
      link.click();

      // Clean up
      link.parentNode?.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Download failed:', error);
    }
  };

  // Scroll chat body on chat update
  useEffect(() => {
    chatBodyRef.current?.scrollTo({
      top: chatBodyRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [chatHistory]);

  return (
    <div className="alert-chat-popover">
      <dialog className="chat-popover-dialog" ref={modalRef}>
        {/* Close Button */}
        <button
          className="chat-popover-dialog-close"
          onClick={closeChatPopover}
        >
          <MingcuteCloseFill />
        </button>
        {/* Body split */}
        <form className="chat-popover-dialog-body" onSubmit={chatFormSubmit}>
          <div className="chat-popover-dialog-body-left-split">
            {/* Alert image */}
            <img
              className="chat-popover-dialog-body-image"
              src={imgUrl}
              alt="alert_image"
            />
            {/* Config option */}
            <div className="chat-popover-dialog-body-config">
              {/* Select model */}
              <div className="chat-popover-dialog-body-config-select">
                <label>Select Model</label>
                <select value={selectedValueInt} onChange={handleChange}>
                  <option value="1">GPT 4o</option>
                  <option value="2">GPT 4-turbo</option>
                </select>
              </div>
            </div>
          </div>
          <div className="chat-popover-dialog-body-right-split">
            {/* Chat */}
            <div className="chat-popover-dialog-body-chat" ref={chatBodyRef}>
              {chatHistory.length > 0 ? (
                chatHistory.map((chat, index) => (
                  <ChatPopoverMessage
                    key={index}
                    message={chat.content}
                    roleUser={chat.role === "user"}
                    avatar={chat.role === "user" ? UserAvatar : undefined}
                  />
                ))
              ) : (
                // If not chat history, show empty chat image
                <img
                  className="empty-chat"
                  src="/assets/img/chat-empty.png"
                  alt="chat-empty"
                />
              )}
            </div>
            {/* Input */}
            <div className="chat-popover-dialog-body-input">
              <input
                type="text"
                placeholder="Type a question..."
                className="text-field"
              />
              <button type="submit" className="send-button">
                <IconamoonSendThin className="send-button-img" />
              </button>
            </div>
            {/* Download your chat */}
            <button
              className="chat-popover-dialog-body-download"
              type="button"
              onClick={() => downloadChat()}
            >
              Download your chat
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
};

export default ChatPopover;
