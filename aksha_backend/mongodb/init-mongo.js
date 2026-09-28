db = db.getSiblingDB("admin");

db.createUser({
  user: "mongo",
  pwd: "mongo",
  roles: [
    {
      role: "root",
      db: "admin"
    }
  ]
});

db = db.getSiblingDB("Aksha");