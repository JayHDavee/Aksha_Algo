export interface SearchTab {
  heading: string;
  text: string;
  active: boolean;
}

export const searchTabs: SearchTab[] = [
  {
    heading: "Date*",
    text: " - ",
    active: false,
  },
  {
    heading: "Time*",
    text: "07:00 - 19:00",
    active: false,
  },
  {
    heading: "Camera*",
    text: "camera1",
    active: false,
  },
  {
    heading: "Object of Interest*",
    text: "",
    active: false,
  },
];
