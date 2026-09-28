import Shepherd from "shepherd.js";
import "../shepherd.css";

const startInsightsTour = (
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
        // ---- Insights ----
    {
      id: "insights-section",
      title:t("Insights"),
      text: t("The Insights tab gives you advanced reports and activity tracking."),
      attachTo: { element: ".insights-section", on: "bottom" },
      buttons: [
        { text: "Next", action: () => tour.next() }],
    },
    {
      id: "insights-activity-tracker",
      title:t("Activity Tracker"),
      text: `<div>
      <img id="insights-activity-tracker-img" alt="OOI" src="/assets/TourImages/OOI.png" style="max-width: 100%;
  height: auto;
  display: block;
  margin: 0 auto;">
      </div>
      <div>${t("Activity Tracker – generates videos highlighting areas of high activity over time.")}</div>`,
      attachTo: { element: ".insights-activity-tracker", on: "bottom" },
      
      buttons: [{ text: t("Back"), action: () => tour.back() },
        { text: t("Next"), action: () => tour.next() }],
        when: {
    show: () => {
      // Wait until the DOM is rendered
      setTimeout(() => {
        const img = document.querySelector("#insights-activity-tracker-img") as HTMLImageElement;
        if (img) {
          img.style.cursor = "pointer";
          img.onclick = () => openModal(img.src);
        }
      }, 0);

    }
    
  }
    },
    {
      id: "insights-reports",
      title:t("Report"),
      text: `<div>
      <img id="insights-reports-img" alt="OOI" src="/assets/TourImages/OOI.png" style="max-width: 100%;
  height: auto;
  display: block;
  margin: 0 auto;">
      </div>
      <div>${t("Reports – download detailed alert reports by camera and time range.")}</div>`,
      attachTo: { element: ".insights-reports", on: "bottom" },
      buttons: [
        {
          text:t("Back"),
          action: () => tour.back(),
        },
        {
          text: t("Finish"),
          action: () => {
            tour.next();
          },
        },
      ],
      when: {
    show: () => {
      // Wait until the DOM is rendered
      setTimeout(() => {
        const img = document.querySelector("#insights-reports-img") as HTMLImageElement;
        if (img) {
          img.style.cursor = "pointer";
          img.onclick = () => openModal(img.src);
        }
      }, 0);

    }
    
  }
    },


  ];

  // Register all steps
  steps.forEach((step) => tour.addStep(step));

  tour.start();
};

export default startInsightsTour;
