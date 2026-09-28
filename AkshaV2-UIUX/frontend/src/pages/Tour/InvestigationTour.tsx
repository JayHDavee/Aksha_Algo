import Shepherd from "shepherd.js";
import "../shepherd.css";

const startInvestigationTour = (
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
   // ---- Investigation ----
    {
      id: "investigation-section",
      title: t("Investigation"),
      text: t("The Investigation tab helps you analyze stored camera data."),
      attachTo: { element: ".investigation-section", on: "bottom" },
      buttons: [    
        { text: t("Next"), action: () => tour.next() }],
    },
    {
      id: "investigation-object-interest",
      title: t("Object of Interest"),
      text: `<div>
      <img id="investigation-object-interest-img" alt="OOI" src="/assets/TourImages/OOI.png" style="max-width: 100%;
  height: auto;
  display: block;
  margin: 0 auto;">
      </div>
      <div>${t("Object of Interest – search for specific objects in past footage by date, time, and camera.")}</div>`,
      attachTo: { element: ".investigation-object-interest", on: "bottom" },
      buttons: [{ text: t("Back"), action: () => tour.back() },
        { text: t("Next"), action: () => tour.next() }],
        when: {
    show: () => {
      // Wait until the DOM is rendered
      setTimeout(() => {
        const img = document.querySelector("#investigation-object-interest-img") as HTMLImageElement;
        if (img) {
          img.style.cursor = "pointer";
          img.onclick = () => openModal(img.src);
        }
      }, 0);

    }
    
  }
    },
    {
      id: "investigation-recent-alerts",
      title:t("Recent Alerts"),
      text: `<div>
      <img id="investigation-recent-alerts-img" alt="OOI" src="/assets/TourImages/OOI.png" style="max-width: 100%;
  height: auto;
  display: block;
  margin: 0 auto;">
      </div>
      <div>${t("Recent Alerts – review alerts generated in the last few hours.")}</div>`,
      attachTo: { element: ".investigation-recent-alerts", on: "bottom" },
      buttons: [{ text: t("Back"), action: () => tour.back() },
        { text: t("Next"), action: () => tour.next() }],
        when: {
    show: () => {
      // Wait until the DOM is rendered
      setTimeout(() => {
        const img = document.querySelector("#investigation-recent-alerts-img") as HTMLImageElement;
        if (img) {
          img.style.cursor = "pointer";
          img.onclick = () => openModal(img.src);
        }
      }, 0);

    }
    
  }
    },
    {
      id: "investigation-my-alerts",
      title:t("My Alerts"),
      text: `<div>
      <img id="investigation-my-alerts-img" alt="OOI" src="/assets/TourImages/OOI.png" style="max-width: 100%;
  height: auto;
  display: block;
  margin: 0 auto;">
      </div>
      <div>${t("My Alerts – check custom alerts you created with time, date, and camera filters.")}</div>`,
      attachTo: { element: ".investigation-my-alerts", on: "bottom" },
      buttons: [{ text: t("Back"), action: () => tour.back() },
        { text: t("Next"), action: () => tour.next() }],
        when: {
    show: () => {
      // Wait until the DOM is rendered
      setTimeout(() => {
        const img = document.querySelector("#investigation-my-alerts-img") as HTMLImageElement;
        if (img) {
          img.style.cursor = "pointer";
          img.onclick = () => openModal(img.src);
        }
      }, 0);

    }
    
  }
    },
    {
      id: "investigation-auto-alerts",
      title:t("Auto Alerts"),
      text: `<div>
      <img id="investigation-auto-alerts-img" alt="OOI" src="/assets/TourImages/OOI.png" style="max-width: 100%;
  height: auto;
  display: block;
  margin: 0 auto;">
      </div>
      <div>${t("Auto Alerts – system-generated alerts for unusual activity.")}</div>`,
      attachTo: { element: ".investigation-auto-alerts", on: "bottom" },
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
        const img = document.querySelector("#investigation-auto-alerts-img") as HTMLImageElement;
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

export default startInvestigationTour;
