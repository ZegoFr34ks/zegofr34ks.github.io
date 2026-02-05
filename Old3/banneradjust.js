$(document).ready(function() {
    updateBackground();
});

$(window).on("load", function() {
    updateBackground();
});

$(window).resize(function() {
    updateBackground();
});

function updateBackground() {
    var windowWidth = $(window).width();
    var video = $(".banner .bloc video");
    var bgImage = $(".banner .bloc .bg-image");

    if (windowWidth <= 768) {
        video.hide();
        bgImage.show();
    } else {
        video.show();
        bgImage.hide();
    }
}
