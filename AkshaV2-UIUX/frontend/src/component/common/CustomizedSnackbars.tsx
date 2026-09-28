import * as React from "react";
import Stack from "@mui/material/Stack";
import Snackbar from "@mui/material/Snackbar";
import MuiAlert, { AlertProps } from "@mui/material/Alert";
import { useState, forwardRef } from "react";

// Props interface
interface CustomizedSnackbarsProps {
  show: boolean;                         // Controls visibility
  message: string;                       // Message content
  indicator: AlertProps["severity"];    // Alert type (success, error, info, warning)
}

// Styles using inline CSS object
const styles = {
  stack: {
    width: "100%",
  } as React.CSSProperties,

  alert: {
    width: "100%",
  } as React.CSSProperties,
};

// Forward ref alert component using MUI's MuiAlert
const Alert = forwardRef<HTMLDivElement, AlertProps>(function Alert(props, ref) {
  return <MuiAlert elevation={6} ref={ref} variant="filled" {...props} />;
});

// Main customized snackbar component
export default function CustomizedSnackbars(props: CustomizedSnackbarsProps) {
  const [vertical] = useState<"top" | "bottom">("top");
  const [horizontal] = useState<"left" | "center" | "right">("center");

  // Handle snackbar close event
  const handleClose = (event?: React.SyntheticEvent | Event, reason?: string) => {
    if (reason === "clickaway") return;
    // Optional: Add custom close logic here
  };

  return (
    <Stack spacing={2} style={styles.stack}>
      <Snackbar
        anchorOrigin={{ vertical, horizontal }}
        open={props.show}
        autoHideDuration={1000}
        onClose={handleClose}
      >
        <Alert
          onClose={handleClose}
          severity={props.indicator}
          style={styles.alert}
        >
          {props.message}
        </Alert>
      </Snackbar>
    </Stack>
  );
}
