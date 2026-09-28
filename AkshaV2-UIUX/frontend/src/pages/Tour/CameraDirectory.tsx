import Shepherd from "shepherd.js";
import "../shepherd.css";

const startCameraDirectoryTour = (
  t: (key: string) => string,
  navigate: (path: string) => void,
  openModal: (src: string) => void
) => {

  const tour = new Shepherd.Tour({
    defaultStepOptions: {
      cancelIcon: { enabled: true },
      scrollTo: { behavior: "smooth", block: "center" },
      classes: "aksha-tour-theme",
    },
    useModalOverlay: false,
  });

  // Define your steps
  const steps = [
     // ---- Camera Directory ----
    {
      id: "camera-directory-section",
      title:t("Camera Directory"),
      text: t("Camera Directory – view, add, edit, or remove your cameras here."),
      attachTo: { element: ".camera-directory-section", on: "bottom" },
      buttons: [
        { text: t("Next"), action: () => tour.next() }],
    },

    {
      id: "camera-directory-section-Add-Camera",
      title:t("Add New Camera"),
      text: t("You can Add New Camera here."),
      attachTo: { element: ".addcam", on: "bottom" },
      buttons: [{ text: t("Back"), 
        action: () => tour.back()},
        { text: t("Next"), action: () => tour.next() }],
    },
    
    {
      id: "camera-directory-section-delete-Camera",
      title:t("Delete Camera"),
      text: t("You can delete Camera here."),
      attachTo: { element: ".deletecam", on: "left" },
      buttons: [{ text: t("Back"), 
        action: () => tour.back()},
        { text: t("Next"), action: () => tour.next() }],
    },
    
    {
      id: "camera-directory-section-View-Camera",
      title:t("View Camera"),
      text: t("You can View Camera details here."),
      attachTo: { element: ".viewcam", on: "left" },
      buttons: [{ text: t("Back"), 
        action: () => tour.back()},
        { text: t("Next"), action: () => tour.next() }],
    },
    
    {
      id: "camera-directory-section-edit-Camera",
      title:t("Edit Camera"),
      text: t("You can Edit Camera here."),
      attachTo: { element: ".editcam", on: "left" },
      buttons: [{ text: t("Back"), 
      action: () => tour.back()},
      { text: t("Next"), action: () =>{
        tour.next();
      },
     }],
    },
    {
      id: "user-manual-section",
      title:t("User Manual"),
      text: t("The User Manual provides a complete guide to using Aksha with step-by-step instructions."),
      attachTo: { element: ".user-manual-section", on: "bottom" },
      buttons: [{ text: t("Back"), action: () => tour.back() },{ text: t("Finish"), action: () => tour.complete() }],
    },
  ];
  // Register all steps
  steps.forEach((step) => {
    const selector = step.attachTo?.element;
    if (!selector || document.querySelector(selector)) {
      tour.addStep(step); // element exists → add the step
    } else {
      console.warn(`Skipping step "${step.id}" — element ${selector} not found.`);
    }
  });

  tour.start();
};

export default startCameraDirectoryTour;
