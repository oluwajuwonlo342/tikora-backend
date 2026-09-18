const organizerOnly = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: "Authentication required.",
    });
  }

  if (
    req.user.role !== "organizer" &&
    req.user.role !== "admin"
  ) {
    return res.status(403).json({
      success: false,
      message: "Organizer access required.",
    });
  }

  next();
};

export { organizerOnly };