// Automatic scrolling for each section
const sections = document.querySelectorAll('section');

// Function to scroll to the next section
function scrollToNextSection() {
    const currentSectionIndex = Array.from(sections).findIndex(section => section.getBoundingClientRect().top >= 0);
    const nextSectionIndex = currentSectionIndex + 1 < sections.length ? currentSectionIndex + 1 : currentSectionIndex;
    sections[nextSectionIndex].scrollIntoView({ behavior: 'smooth' });
}

// Function to scroll to the previous section
function scrollToPrevSection() {
    const currentSectionIndex = Array.from(sections).findIndex(section => section.getBoundingClientRect().top >= 0);
    const prevSectionIndex = currentSectionIndex - 1 >= 0 ? currentSectionIndex - 1 : currentSectionIndex;
    sections[prevSectionIndex].scrollIntoView({ behavior: 'smooth' });
}

// Event listener for scrolling
document.addEventListener('wheel', (event) => {
    if (event.deltaY > 0) {
        scrollToNextSection();
    } else {
        scrollToPrevSection();
    }
});
