log("Running in the active tab:", location.href);

const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
  .slice(0, 10)
  .map((el) => el.textContent.trim())
  .filter(Boolean);

return {
  title: document.title,
  url: location.href,
  headings,
  links: document.links.length,
  buttons: document.querySelectorAll("button,[role='button']").length,
};
