import * as React from "react";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import Slide from "@mui/material/Slide";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import { TransitionProps } from "@mui/material/transitions";

/**
 * Props for the ImageModel dialog component.
 */
interface ImageModelProps {
  open: boolean;            // Controls whether the dialog is open
  setOpen: (value: boolean) => void; // Function to change open state (typically from parent)
  imgUrl: string;           // URL of the image to display
}

/**
 * Slide transition component for Dialog.
 * Direction "up" means the dialog slides in from the bottom.
 */
const Transition = React.forwardRef(function Transition(
  props: TransitionProps & { children: React.ReactElement },
  ref: React.Ref<unknown>
) {
  return <Slide direction="up" ref={ref} {...props} />;
});

/**
 * ImageModel Component
 *
 * A reusable modal/dialog component for displaying an image.
 * Uses MUI's Dialog and Slide transition.
 *
 * Used in:
 * - monitor/Active.tsx
 * - monitor/Spotlight.tsx
 *
 * @component
 */
const ImageModel: React.FC<ImageModelProps> = ({ open, setOpen, imgUrl }) => {
  /**
   * Handles closing the modal.
   */
  const handleClose = () => {
    setOpen(false);
  };

  return (
    <div>
      <Dialog
        open={open}
        TransitionComponent={Transition}
        keepMounted
        onClose={handleClose}
        aria-describedby="image-dialog-description"
      >
        <DialogContent>
          <CloseRoundedIcon
            sx={{
              border: "2px solid black",
              borderRadius: "12px",
              position: "absolute",
              right: "2rem",
              top: "2rem",
              cursor: "pointer",
            }}
            onClick={handleClose}
          />
          {imgUrl !== "" && (
            <img src={imgUrl} alt="camera img" className="w-100 h-100" />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ImageModel;
