$(window).resize(function() {
    updateLinks();
  });

  function updateLinks() {
    var windowWidth = $(window).width();
    var githubLink = $(".github");
    var websiteLink = $(".website");

    if (windowWidth <= 768) {
      githubLink.text("Github");
      websiteLink.text("Website");
    } else {
      githubLink.text("Github: https://github.com/ZegoFr34ks/zegofr34ks.github.io");
      websiteLink.text("Website: https://zegofr34ks.github.io");
    }
  }

  $(document).ready(function() {
    updateLinks();
  });