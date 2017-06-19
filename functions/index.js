var functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp(functions.config().firebase);

const pathToMedicineDetails = 'User/{name}/Medicine-Box/Compartment-Details/{pushId}/compartmentDetailsMap/{compartmentNumber}/medicineDetails';
const pathToCompartmentNumber = 'User/{name}/Medicine-Box/Compartment-Details/{pushId}/compartmentDetailsMap/{compartmentNumber}';
const pathToMedicineOrder = 'Medicine-Order/Active/{pushId}';
const pathToMedicineOrderAvailability = 'Medicine-Order/Active/{pushId}/availability';
const pathToTargetSinglePharmacy = "Medicine-Order/Active/{pushId}/targetSinglePharmacy";
const pathToRunOutAlert = "User/{name}/Medicine-Box/Compartment-Details/{pushId}/compartmentDetailsMap/{compartmentNumber}/runOutAlert";

/*
 When the user add a medicine by specifying the medicine name, the cloud function will
 search based on the name in the pharmacy database, and it will extract the extra info
 and copy into the user's medicine info storage directory in firebase database
 */
exports.addMedicineDataEntry =
    functions.database
        .ref(pathToMedicineDetails)
        .onWrite(function (event) {
            const medicineDetails = event.data.val();
            const getMedicineNamePromise = event.data.ref.child("medicineName").once('value');
            const getDrugStorePromise = event.data.ref.child("drugstore").once('value');

            return Promise.all([getMedicineNamePromise, getDrugStorePromise]).then(function (results) {
                const medicineNameSnapshot = results[0];
                const drugStoreSnapshot = results[1];

                var pharmacyRef = admin.database().ref('Pharmacy/' + drugStoreSnapshot.val() + '/Pharmacy-Medicine-Details');

                pharmacyRef.orderByChild('medicineName').equalTo(medicineNameSnapshot.val()).on('child_added', function (snapshot) {
                    var description = snapshot.child("description").val();
                    var frequencyOfTaking = snapshot.child("frequencyOfTaking").val();
                    var medicineId = snapshot.child("id").val();
                    var medicineImg = snapshot.child("medicineImage").val();
                    var medicineMoreInfo = snapshot.child("medicineMoreInfo").val();
                    var price = snapshot.child("price").val();
                    var pharmacyDetailsRef = admin.database().ref('Pharmacy/' + drugStoreSnapshot.val() + '/Pharmacy-Details');
                    pharmacyDetailsRef.on("value", function (detailsSnapshot) {
                        var pharmacyDetails = detailsSnapshot.val();
                        if (medicineDetails !== null) {
                            event.data.ref.child("description").set(description);
                            event.data.ref.child("frequencyOfTaking").set(frequencyOfTaking);
                            event.data.ref.child("id").set(medicineId);
                            event.data.ref.child("medicineImage").set(medicineImg);
                            event.data.ref.child("medicineMoreInfo").set(medicineMoreInfo);
                            event.data.ref.child("price").set(price);
                            event.data.ref.child("pharmacyDetails").set(pharmacyDetails);
                        }
                    });

                });
            }, function (errorObject) {
                console.log("The read failed: " + errorObject.code);
            });

        });

/*
 Send follower notification when the runOutAlert is set to true, this indicate the medicine in a compartment
 has run out, the notification will pass the medicineBox id and the compartmentNumber of the drugbox to the
 user
 */
exports.sendFollowerNotification = functions.database.ref(pathToRunOutAlert).onWrite(function (event) {
    const getFCMTokenPromise = admin.database().ref("User/" + event.params.name + "/registrationToken").once('value');
    console.log('Run out alert trigger for user : ' + event.params.name);
    console.log("Run out alert is " + event.data.val());
    return Promise.all([getFCMTokenPromise]).then(function (results) {
        const tokensSnapshot = results[0];
        if (event.data.val() === true) {
            console.log("The token is " + tokensSnapshot.val());

            const getCompartmentDetails = event.data.ref.parent.once("value");

            return Promise.all([getCompartmentDetails]).then(function (results) {
                var snapshot = results[0];
                var fillUpStatus = safeParseString(snapshot.child("fillUpStatus").val());
                //id represents the compartment number
                var id = safeParseString(snapshot.child("id").val());
                var medicineBoxId = safeParseString(snapshot.child("medicineBoxId").val());
                // Notification details.
                console.log("Notificaiton is sending out");
                const payload = {
                    data: {
                        id: id,
                        medicineBoxId: medicineBoxId,
                        action: "MedicineRunOutAction",
                        userGroup: "User",
                        sender: "System",
                        priority: "High"
                    },
                    notification: {
                        title: event.params.compartmentNumber + " has run out",
                        body: "Do you want to refill online now ?"
                    }
                };
                // Listing all tokens.
                const tokens = tokensSnapshot.val();

// Send notifications to all tokens.
                return admin.messaging().sendToDevice(tokens, payload);
            });
        }
    })
});

/*
 The function will send notification to the pharmacy that subscribe the topic
 */
exports.sendPharmacyNotification = functions.database.ref(pathToMedicineOrder).onWrite(function (event) {

    const snapshot = event.data;

    //we only send notification when there is new medicine order added
    if (snapshot.previous.val()) {
        return;
    }

    if (snapshot.val().targetSinglePharmacy === true) {
        console.log(snapshot.val());
        console.log(snapshot.val().targetSinglePharmacy);
        var pharmacyName = snapshot.val().medicineDetails.drugstore;
        const payload = {
            data: {
                action: "NewSpecializedOrderAction",
                userGroup: "Pharmacy",
                sender: "System",
                priority: "High"
            },
            notification: {
                title: "New Order added into queue ",
                body: "Click to knore more!"
            }
        };
        console.log("Send Notification by token");
        sendNotificationToSinglePharmacy(pharmacyName, payload);
    } else {
        const payload = {
            data: {
                action: "NewMedicineOrderAction",
                userGroup: "Pharmacy",
                sender: "System",
                priority: "Medium"
            },
            notification: {
                title: "New order comes in",
                body: "Click to know more !"
            }
        };
        console.log("Send Notification by Topic ");
        return admin.messaging().sendToTopic("medicineOrder", payload);
    }


});

exports.convertOrderToPharmacyOrderQueue = functions.database.ref(pathToMedicineOrder).onWrite(function (event) {
    const medicineOrder = event.data.val();
    const targetSinglePharmacy = medicineOrder.targetSinglePharmacy;
    const availability = medicineOrder.availability;
    if (targetSinglePharmacy === true || availability === false) {
        var pharmacyDetails = medicineOrder.pharmacyDetails;
        var pharmacyName = pharmacyDetails.pharmacyName;
        var targetPharmacyRef = admin.database().ref("Pharmacy/" + pharmacyName);
        targetPharmacyRef.child("/Order-Queue").child(medicineOrder.id).set(medicineOrder);
        const userPayload = {
            data: {
                action: "MedicineOrderAcceptedAction",
                userGroup: "User",
                sender: "System",
                priority: "Medium"
            },
            notification: {
                title: "Medicine Order Accepted",
                body: "Just sit still and wait for your medicine !"
            }
        };

        const pharmacyPayload = {
            data: {
                action: "NewSpecializedOrderAction",
                userGroup: "Pharmacy",
                sender: "System",
                priority: "High"
            },
            notification: {
                title: "New order added into queue",
                body: "Send the medicine to your customer asap !"
            }
        };
        event.data.ref.parent.remove();
        sendNotificationToSinglePharmacy(medicineOrder.pharmacyDetails.pharmacyName,pharmacyPayload);
        return sendNotificationToSingleUser(medicineOrder.userName, userPayload);
    }
});

/*
 Get the requestedMedicine name from the user and send back to the drugstore name and medicine details back to the client
 */
exports.getPharmacyNameWithParticularMedicine = functions.https.onRequest(function (req, res) {
    var pharmacyRef = admin.database().ref('Pharmacy');
    var requestedMedicineName = req.body.medicineName;
    var keyList = [];
    var pharmacyList = [];

    pharmacyRef.on("value", function (pharmacySnapshot) {
        pharmacySnapshot.forEach(function (snapshot) {
            var pharmacy = snapshot.val();
            var pharmacyDetails = pharmacy["Pharmacy-Details"];
            var pharmacyName = pharmacyDetails.pharmacyName;
            var medicineDetails = pharmacy["Pharmacy-Medicine-Details"];
            for (var key in medicineDetails) {
                if (medicineDetails.hasOwnProperty(key)) {
                    var medicineName = medicineDetails[key].medicineName;
                    if (medicineName === requestedMedicineName) {
                        keyList.push(key);
                        medicineDetails[key].showStatus = undefined;
                        medicineDetails[key].drugstore = pharmacyName;
                        medicineDetails[key].pharmacyDetails = pharmacyDetails;
                        pharmacyList.push(medicineDetails[key]);
                    }
                }
            }
        });
        res.status(200).send(pharmacyList);
    });
});

function sendNotificationToSingleUser(userName, payload) {
    var registrationTokenRef = admin.database().ref("User/" + userName).child("registrationToken");
    var registrationTokenPromise = registrationTokenRef.once('value');
    return Promise.all([registrationTokenPromise]).then(function (results) {
        var registrationTokenSnapshot = results[0];
        const token = registrationTokenSnapshot.val();
        return admin.messaging().sendToDevice(token, payload);
    });
}

function sendNotificationToSinglePharmacy(pharmacyName, payload) {
    var registrationTokenRef = admin.database().ref("Pharmacy/" + pharmacyName).child("registrationToken");
    var registrationTokenPromise = registrationTokenRef.once('value');
    return Promise.all([registrationTokenPromise]).then(function (results) {
        var registrationTokenSnapshot = results[0];
        const token = registrationTokenSnapshot.val();
        return admin.messaging().sendToDevice(token, payload);
    });
}

function safeParseString(obj) {
    if (obj !== null) {
        return obj.toString();
    } else {
        return "";
    }
}