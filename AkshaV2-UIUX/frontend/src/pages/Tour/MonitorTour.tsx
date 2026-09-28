import Shepherd from "shepherd.js";
import "../shepherd.css";
import { useTranslation } from "react-i18next";

const startMonitorTour = (
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
    {
      id: "monitor-section",
      title: t("Monitor"),
      text: t("The Monitor tab shows live feeds from all your cameras."),
      attachTo: { element: ".monitor-section", on: "bottom" },
      buttons: [
        { text: t("Next"), action: () => tour.next() },
      ],
    },
    {
      id: "monitor-live",
      title: t("Live"),
      text: `
        <div>
          <img id="monitor-live-img" alt="OOI" src="/assets/TourImages/OOI.png" style="max-width: 100%; height: auto; display: block; margin: 0 auto;">
        </div>
        <div>${t("Here you can see all cameras in real-time. Alerts will appear directly on the live screen.")}</div>
      `,
      attachTo: { element: ".monitor-live", on: "bottom" },
      buttons: [
        { text: t("Back"), action: () => tour.back() },
        { text: t("Next"), action: () => tour.next() },
      ],
      when: {
        show: () => {
          setTimeout(() => {
            const img = document.querySelector("#monitor-live-img") as HTMLImageElement;
            if (img) {
              img.style.cursor = "pointer";
              img.onclick = () => openModal(img.src);
            }
          }, 0);
        },
      },
    },
    {
      id: "monitor-spotlight",
      title: t("Spotlight"),
      text: `
        <div>
          <img id="monitor-spotlite-img" alt="Spotlight" src="/assets/TourImages/OOI.png" style="max-width: 100%; height: auto; display: block; margin: 0 auto;">
        </div>
        <div>${t("Spotlight highlights only the cameras that currently have active alerts.")}</div>
      `,
      attachTo: { element: ".monitor-spotlight", on: "bottom" },
      buttons: [
        { text: t("Back"), action: () => tour.back() },
        {
          text: t("Finish"),
          action: () => {
            tour.complete(); // End the tour on this page
          },
        },
      ],
      when: {
        show: () => {
          setTimeout(() => {
            const img = document.querySelector("#monitor-spotlite-img") as HTMLImageElement;
            if (img) {
              img.style.cursor = "pointer";
              img.onclick = () => openModal(img.src);
            }
          }, 0);
        },
      },
    },
  ];

  // Register all steps
  steps.forEach((step) => tour.addStep(step));

  tour.start();
};

export default startMonitorTour;
